"""Patch JOINTS_0 / WEIGHTS_0 of one skinned primitive inside a GLB, byte-for-byte (JSON chunk untouched)."""
import struct, json, sys, numpy as np


def patch(src, dst, mesh_index, J, W, prim=0):
    raw = bytearray(open(src, 'rb').read())
    magic, ver, length = struct.unpack_from('<III', raw, 0)
    assert magic == 0x46546C67
    off = 12
    jlen, jtype = struct.unpack_from('<II', raw, off); js = json.loads(raw[off + 8:off + 8 + jlen].decode('utf8'))
    boff = off + 8 + jlen
    blen, btype = struct.unpack_from('<II', raw, boff); bstart = boff + 8
    p = js['meshes'][mesh_index]['primitives'][prim]['attributes']
    for key, data in (('JOINTS_0', J), ('WEIGHTS_0', W)):
        a = js['accessors'][p[key]]; bv = js['bufferViews'][a['bufferView']]
        start = bstart + bv.get('byteOffset', 0) + a.get('byteOffset', 0)
        assert bv.get('byteStride') in (None, 0)
        dt = {5121: np.uint8, 5123: np.uint16, 5126: np.float32}[a['componentType']]
        arr = np.ascontiguousarray(np.asarray(data).astype(dt))
        assert arr.size == a['count'] * 4, (arr.shape, a['count'])
        raw[start:start + arr.nbytes] = arr.tobytes()
    open(dst, 'wb').write(bytes(raw))
    return js


if __name__ == '__main__':
    J = np.load('tp_weights_J.npy'); W = np.load('tp_weights_W.npy').astype(np.float32)
    W = W / W.sum(1, keepdims=True)
    patch('Potato_TP_Character.glb', 'Potato_TP_Character_v5.glb', 3, J, W)
    # verify
    from rig import Rig
    a = Rig('Potato_TP_Character.glb'); b = Rig('Potato_TP_Character_v5.glb')
    ma, mb = a.mesh_data(3)[0], b.mesh_data(3)[0]
    print('positions identical', np.array_equal(ma['pos'], mb['pos']), '| joints changed', int((ma['joints'] != mb['joints']).any(1).sum()),
          '| weights changed', int((np.abs(ma['weights'] - mb['weights']) > 1e-6).any(1).sum()), '| max |sum-1|', float(np.abs(mb['weights'].sum(1) - 1).max()))
    import os; print('size', os.path.getsize('Potato_TP_Character.glb'), os.path.getsize('Potato_TP_Character_v5.glb'))
