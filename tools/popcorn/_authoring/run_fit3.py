import numpy as np, json, pickle
import grip_fit as gf
from grip_candidates import views
from PIL import Image
from scipy.spatial.transform import Rotation as Rot
g = json.load(open('pump_grip.json')); F = np.array(g['offhand_local']); cu = g['curls']
WL = F.copy(); WL[:3,3] *= gf.UNIT
H0 = WL @ np.linalg.inv(gf.WL_LOCAL)
print('block x (rest) mm', gf.BLOCK_X*1000, 'at travel', (gf.BLOCK_X-gf.TRAVEL)*1000)
want = np.array([0.30, -0.35, 0.89]); want /= np.linalg.norm(want)
out = []
for psi in [0.0, -0.35, 0.35]:
    for dx in [-0.02, -0.03]:
        H = H0.copy()
        H[:3,:3] = H[:3,:3] @ Rot.from_rotvec([psi,0,0]).as_matrix()   # rotate about the palm normal (hand X)
        H[0,3] += dx
        H[:3,3] -= H[:3,0]*0.004
        print(f'--- psi {psi} dx {dx}')
        Hf, cf = gf.fit2(H, cu, want)
        v = gf.hand_vertices(Hf, cf); fm = np.isin(gf.DOMSEL, ['Index_L_1','Middle_L_1','Ring_L_1'])
        print('   fingers x span mm', round(1000*v[fm,0].min(),1), round(1000*v[fm,0].max(),1), 'all max x', round(1000*v[:,0].max(),1))
        out.append((psi, dx, Hf, cf))
pickle.dump(out, open('fit3_results.pkl','wb'))
imgs = []
for psi, dx, Hf, cf in out:
    imgs += views(Hf, cf, f'psi{psi} dx{dx}')
S = Image.new('RGB', (1200, 240*len(out))); [S.paste(im, ((k%4)*300, (k//4)*240)) for k, im in enumerate(imgs)]; S.save('fit3_views.png')
