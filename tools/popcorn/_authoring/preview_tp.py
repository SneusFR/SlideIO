import pickle, sys, numpy as np
from PIL import Image
from rig import Rig, trs
from scene import drawables
from raster import Renderer, look_at
import weapon_def as wd
import author_fp  # offhand frame
clips = pickle.load(open('tp_clips.pkl','rb')); M = clips['_meta']['mount']
ch = Rig('Potato_TP_Character.glb'); base = ch.rest_pose()
S = trs(s=(wd.ROOT_SCALE,)*3)
def frame_img(name, i, eye, size=(360,360), popcorn=None, fov=30):
    c = clips[name]; p = dict(base); p.update(c['frames'][i]); pump,lid,trig = c['weapon'][i]
    W = ch.world(p); G = W['Weapon_R'] @ M @ S; Wn = wd.world_nodes(G, pump, lid, trig)
    r = Renderer(*size, fov=fov); r.set_camera(look_at(eye, (0,0.45,0.08)))
    for d in drawables(ch, W): r.draw(*d)
    wd.draw_weapon(r, Wn, popcorn=popcorn)
    return r.image(label=f'{name[3:-16]} t={i/c["fps"]:.2f}', markers=[(W['Weapon_L'][:3,3],(0,255,255)),(Wn['Offhand'][:3,3],(0,255,0))])
def sheet(name, n=6, eyes=((1.1,0.8,1.2),(-1.2,0.7,0.6)), out=None, popcorn=None):
    c = clips[name]; N = len(c['frames']); idx = np.linspace(0,N-1,n).round().astype(int)
    rows=[]
    for eye in eyes:
        rows.append([frame_img(name,i,eye,popcorn=popcorn) for i in idx])
    Sx = Image.new('RGB',(360*n, 360*len(eyes)))
    for r,row in enumerate(rows):
        for k,im in enumerate(row): Sx.paste(im,(k*360,r*360))
    Sx.save(out or f'sheet_{name}.png')
if __name__=='__main__':
    pcs=list(np.load('tmp_pop.npy'))
    sheet(sys.argv[1], int(sys.argv[2]) if len(sys.argv)>2 else 6, popcorn=pcs)
