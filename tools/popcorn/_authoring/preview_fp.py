import pickle, sys, numpy as np
from PIL import Image, ImageDraw
from fp_common import arms, weapon_root_world, render
import weapon_def as wd
clips = pickle.load(open('fp_clips.pkl','rb'))
meta = clips['_meta']; M = meta['mount']; wd.OFFHAND_LOCAL = meta['offhand']
base = arms.rest_pose()
def pose_at(clip, i):
    p = dict(base); p.update(clip['frames'][i]); return p
def sheet(name, n=8, size=(480,270), popcorn=None, out=None, cols=4, frames=None):
    c = clips[name]; N = len(c['frames'])
    idx = frames if frames is not None else np.linspace(0, N-1, n).round().astype(int)
    imgs=[]
    for i in idx:
        pump, lid, trig = c['weapon'][i]
        img,_,_ = render(pose_at(c,i), M, pump, lid, trig, popcorn=popcorn, size=size, label=f'{name} t={i/c["fps"]:.2f}')
        imgs.append(img)
    rows = (len(imgs)+cols-1)//cols
    S = Image.new('RGB',(size[0]*cols, size[1]*rows))
    for k,im in enumerate(imgs): S.paste(im,((k%cols)*size[0],(k//cols)*size[1]))
    S.save(out or f'sheet_{name}.png'); return S
if __name__=='__main__':
    pcs = list(np.load('tmp_pop.npy'))
    name = sys.argv[1]; n = int(sys.argv[2]) if len(sys.argv)>2 else 8
    sheet(name, n, popcorn=pcs)
