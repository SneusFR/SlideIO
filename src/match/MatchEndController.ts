import { EndScreen } from "../endscreen/EndScreen";
import displayFontUrl from "../endscreen/fonts/LilitaOne-Regular.ttf";
import bodyFontUrl from "../endscreen/fonts/Nunito-Variable.woff";
import type { Game } from "../game/Game";
import type { MultiplayerClient, MatchEndedEvent } from "../network/MultiplayerClient";
import { savePendingReturn } from "../network/LobbyController";
import { loadDisplayName } from "../network/MultiplayerConfig";
import { loadMapSelection, saveMapSelection } from "../world/MapSelection";
import { MapId, isMapId } from "../../shared/map/MapRegistry";
import type { MatchResults } from "../../shared/match/MatchResultsTracker";
import { MAP_VOTE_SECONDS } from "../../shared/match/MatchRules";
import { buildEndScreenData } from "./EndScreenData";

/** Every map is offered in the vote (registry order). */
const VOTE_MAPS: readonly MapId[] = Object.values(MapId);

/**
 * End-of-match flow (5-minute FFA clock ran out):
 *
 *   freeze the game → capture the last frame → EndScreen (glass shatter
 *   intro, leaderboard, REAL stats, next-map vote) → next match.
 *
 * SOLO: the vote is local (bots vote too, like real players would);
 *   the winning map is replayed — instantly when it is the loaded map,
 *   otherwise through the usual save-map-and-reload boot.
 * MULTIPLAYER: the SERVER owns everything — final results (MATCH_ENDED),
 *   the vote tally (MAP_VOTES) and the decision (MATCH_RETURN). Every
 *   client then reloads onto the voted map and rejoins the same room with
 *   its seat token; the host starts the next match from the lobby.
 */
export class MatchEndController {
  private screen: EndScreen | null = null;
  private botVoteTimers: number[] = [];
  /** MULTIPLAYER: room id captured at the end (rejoin after the reload). */
  private roomId: string | null = null;
  /** Hook to hide the gameplay HUD / pause menu while the screen is up. */
  onShown: (() => void) | null = null;
  /** Hook fired when a SOLO replay resumes gameplay on the same map. */
  onSoloReplay: (() => void) | null = null;

  constructor(
    private readonly game: Game,
    private readonly multiplayer: MultiplayerClient,
  ) {
    game.onSoloMatchEnded = (results) => void this.showSolo(results);
    multiplayer.onMatchEnded = (event) => void this.showMultiplayer(event);
    multiplayer.onMapVotes = (votes) => this.screen?.setVotes(votes);
    multiplayer.onMatchReturn = (event) => this.returnToLobby(event.mapId, event.returnToken);
  }

  get isShowing(): boolean {
    return this.screen !== null;
  }

  // ------------------------------------------------------------------ solo

  private async showSolo(results: MatchResults): Promise<void> {
    const localId = this.game.soloLocalPlayerId;
    const data = buildEndScreenData(results, localId, loadMapSelection(), VOTE_MAPS);
    const screen = this.open({
      autoEndVote: true,
      onVote: () => {},
      onVoteEnd: (mapId) => this.replaySolo(mapId),
    });
    await screen.show(data, { snapshot: this.game.captureFrame() });
    if (this.screen !== screen) return;
    this.simulateBotVotes(screen, results, localId);
  }

  /**
   * Bots vote like players would: one ballot each, spread over the
   * countdown, slightly favouring the map that was just played.
   */
  private simulateBotVotes(screen: EndScreen, results: MatchResults, localId: string): void {
    const votes: Record<string, string[]> = Object.fromEntries(VOTE_MAPS.map((id) => [id, []]));
    const current = loadMapSelection();
    const weights = VOTE_MAPS.map((id) => (id === current ? 1.4 : 1));
    const total = weights.reduce((a, b) => a + b, 0);
    for (const p of results.players) {
      if (p.id === localId) continue;
      const delay = (1 + Math.random() * (MAP_VOTE_SECONDS - 4)) * 1000;
      this.botVoteTimers.push(
        window.setTimeout(() => {
          let r = Math.random() * total;
          let pick = VOTE_MAPS.length - 1;
          for (let i = 0; i < VOTE_MAPS.length; i++) {
            r -= weights[i];
            if (r <= 0) {
              pick = i;
              break;
            }
          }
          votes[VOTE_MAPS[pick]].push(p.id);
          screen.setVotes(votes);
        }, delay),
      );
    }
  }

  private replaySolo(mapId: string): void {
    this.clearBotVotes();
    window.setTimeout(() => {
      if (isMapId(mapId) && mapId !== loadMapSelection()) {
        // Another map: single boot loading phase (same flow as the menu).
        saveMapSelection(mapId);
        window.location.assign("/");
        return;
      }
      void this.close().then(() => {
        this.game.restartSoloMatch();
        this.onSoloReplay?.();
        this.game.requestPointerLock();
      });
    }, 1400);
  }

  // ----------------------------------------------------------- multiplayer

  private async showMultiplayer(event: MatchEndedEvent): Promise<void> {
    this.game.endMatch();
    this.roomId = this.multiplayer.roomId;
    const localId = this.multiplayer.sessionId ?? "";
    const maps = event.maps.length > 0 ? event.maps : VOTE_MAPS;
    const data = buildEndScreenData(event.results, localId, event.mapId, maps);
    const screen = this.open({
      voteDuration: event.voteSeconds,
      // The SERVER closes the vote (MATCH_RETURN) — never locally.
      autoEndVote: false,
      onVote: (mapId) => this.multiplayer.sendMapVote(mapId),
      onVoteEnd: () => {},
    });
    await screen.show(data, { snapshot: this.game.captureFrame() });
  }

  /** Vote closed by the server: show the winner, reload onto it, rejoin. */
  private returnToLobby(mapId: string, returnToken: string): void {
    if (!isMapId(mapId)) return;
    this.screen?.endVote(mapId);
    const roomId = this.roomId ?? this.multiplayer.roomId;
    window.setTimeout(() => {
      if (roomId) {
        savePendingReturn({ roomId, map: mapId, token: returnToken, name: loadDisplayName() ?? "" });
      }
      saveMapSelection(mapId);
      void this.multiplayer.leaveLobby().finally(() => window.location.assign("/"));
    }, 2200);
  }

  // --------------------------------------------------------------- common

  private open(opts: {
    voteDuration?: number;
    autoEndVote: boolean;
    onVote: (mapId: string) => void;
    onVoteEnd: (mapId: string) => void;
  }): EndScreen {
    this.screen?.dispose();
    const screen = new EndScreen({
      fonts: { display: displayFontUrl, body: bodyFontUrl },
      voteDuration: opts.voteDuration ?? MAP_VOTE_SECONDS,
      autoEndVote: opts.autoEndVote,
      zIndex: 120,
      onVote: opts.onVote,
      onVoteEnd: opts.onVoteEnd,
      onQuit: () => this.quit(),
    });
    this.screen = screen;
    if (document.pointerLockElement) document.exitPointerLock();
    this.onShown?.();
    return screen;
  }

  private async close(): Promise<void> {
    const screen = this.screen;
    this.screen = null;
    this.clearBotVotes();
    if (!screen) return;
    await screen.hide();
    screen.dispose();
  }

  /** QUIT: leave the room (multiplayer) and go back to the main menu. */
  private quit(): void {
    this.clearBotVotes();
    void (async () => {
      if (this.multiplayer.isConnected) await this.multiplayer.leaveLobby();
      window.location.assign("/");
    })();
  }

  private clearBotVotes(): void {
    for (const t of this.botVoteTimers) clearTimeout(t);
    this.botVoteTimers = [];
  }
}
