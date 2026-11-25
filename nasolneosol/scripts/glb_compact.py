# glb_repack.py 결과에서 쓰지 않는 데이터(옛 텍스처·옛 UV·TANGENT) 제거
# 사용: python3 glb_compact.py 입력.glb 출력.glb
import json, struct, sys

def read(p):
    b = open(p, 'rb').read(); off = 12; ch = []
    while off < len(b):
        l, t = struct.unpack('<II', b[off:off+8]); ch.append(b[off+8:off+8+l]); off += 8 + l
    return json.loads(ch[0]), ch[1]

def main(src, dst):
    j, binb = read(src)
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'].pop('TANGENT', None)
    used_acc = set()
    for m in j['meshes']:
        for p in m['primitives']:
            used_acc |= set(p['attributes'].values())
            if 'indices' in p: used_acc.add(p['indices'])
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: used_acc.add(s['inverseBindMatrices'])
    for a in j.get('animations', []):
        for sm in a['samplers']: used_acc |= {sm['input'], sm['output']}
    acc_map = {}; new_acc = []
    for i in sorted(used_acc):
        acc_map[i] = len(new_acc); new_acc.append(j['accessors'][i])
    used_bv = sorted({a['bufferView'] for a in new_acc if 'bufferView' in a} | {im['bufferView'] for im in j.get('images', []) if 'bufferView' in im})
    out = bytearray(); bv_map = {}; new_bv = []
    for i in used_bv:
        bv = j['bufferViews'][i]
        while len(out) % 4: out.append(0)
        data = binb[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]
        nb = dict(bv); nb['byteOffset'] = len(out); out.extend(data)
        bv_map[i] = len(new_bv); new_bv.append(nb)
    while len(out) % 4: out.append(0)
    for a in new_acc:
        if 'bufferView' in a: a['bufferView'] = bv_map[a['bufferView']]
    for im in j.get('images', []):
        if 'bufferView' in im: im['bufferView'] = bv_map[im['bufferView']]
    for m in j['meshes']:
        for p in m['primitives']:
            p['attributes'] = {k: acc_map[v] for k, v in p['attributes'].items()}
            if 'indices' in p: p['indices'] = acc_map[p['indices']]
    for s in j.get('skins', []):
        if 'inverseBindMatrices' in s: s['inverseBindMatrices'] = acc_map[s['inverseBindMatrices']]
    for a in j.get('animations', []):
        for sm in a['samplers']: sm['input'] = acc_map[sm['input']]; sm['output'] = acc_map[sm['output']]
    j['accessors'] = new_acc; j['bufferViews'] = new_bv; j['buffers'] = [{'byteLength': len(out)}]
    js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(out)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total)); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(out), 0x004E4942)); f.write(out)
    print(dst, total)

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
