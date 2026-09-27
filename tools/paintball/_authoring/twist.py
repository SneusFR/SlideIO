import numpy as np, pickle
from scipy.spatial.transform import Rotation as Rot
def swing_twist(q, axis=np.array([0,1.0,0])):
    """q (x,y,z,w) local rotation; returns (swing_deg, twist_deg) about `axis` (bone Y)."""
    q = np.asarray(q, float)
    p = np.dot(q[:3], axis) * axis
    tw = np.array([p[0], p[1], p[2], q[3]]); n = np.linalg.norm(tw)
    if n < 1e-9: return 180.0, 0.0
    tw /= n
    twist = 2*np.degrees(np.arctan2(np.dot(tw[:3], axis), tw[3]))
    sw = (Rot.from_quat(q) * Rot.from_quat(tw).inv()).magnitude()
    twist = (twist + 180) % 360 - 180
    return np.degrees(sw), twist
if __name__ == '__main__':
    from rig import Rig
    import fp_common as F
    rest = F.arms.rest_pose(); hexp = F.hold_ref()
    for b in ['UpperArm_L','LowerArm_L','Hand_L']:
        print('rest', b, np.round(swing_twist(rest[b][1]),1), ' hex hold', np.round(swing_twist(hexp[b][1]),1))
    clips = pickle.load(open('fp_clips.pkl','rb'))
    for nm in ['FP_PopcornShotgun_Hold','FP_Fire_PopcornShotgun','FP_Reload_PopcornShotgun','FP_Inspect_PopcornShotgun','FP_Equip_PopcornShotgun']:
        c = clips[nm]; rows=[]
        for i,f in enumerate(c['frames']):
            rows.append([*swing_twist(f['Hand_L'][1]), *swing_twist(f['LowerArm_L'][1])])
        rows = np.array(rows)
        k = np.argmax(np.abs(rows[:,1]))
        print(f'{nm:28s} Hand_L swing max {rows[:,0].max():6.1f} twist range [{rows[:,1].min():6.1f},{rows[:,1].max():6.1f}] (worst t={k/c["fps"]:.2f})  LowerArm swing max {rows[:,2].max():6.1f} twist [{rows[:,3].min():6.1f},{rows[:,3].max():6.1f}]')
