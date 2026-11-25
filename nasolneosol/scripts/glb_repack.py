# 생성 GLB 텍스처를 UV 섬별로 여백을 두고 다시 배치(재아틀라스) → 밉맵 색 번짐(흰 금) 제거
# 사용: python3 glb_repack.py 입력.glb 출력.glb      (numpy, Pillow 필요)
# 이어서 glb_compact.py 로 옛 텍스처 등 미사용 데이터를 지운다.
import json, struct, io, sys
import numpy as np
from PIL import Image, ImageDraw

def read_glb(path):
    b = open(path, 'rb').read()
    off = 12; chunks = []
    while off < len(b):
        l, t = struct.unpack('<II', b[off:off+8]); chunks.append(b[off+8:off+8+l]); off += 8 + l
    return json.loads(chunks[0]), bytearray(chunks[1])

def acc_data(j, binb, ai):
    a = j['accessors'][ai]; bv = j['bufferViews'][a['bufferView']]
    comp = {5126: np.float32, 5125: np.uint32, 5123: np.uint16, 5121: np.uint8}[a['componentType']]
    n = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}[a['type']]
    start = bv.get('byteOffset', 0) + a.get('byteOffset', 0)
    stride = bv.get('byteStride', 0)
    isz = np.dtype(comp).itemsize * n
    if stride and stride != isz:
        raw = np.frombuffer(bytes(binb), dtype=np.uint8)
        rows = np.stack([raw[start + i*stride: start + i*stride + isz] for i in range(a['count'])])
        return rows.view(comp).reshape(a['count'], n)
    return np.frombuffer(bytes(binb[start:start + isz * a['count']]), dtype=comp).reshape(a['count'], n).copy()

def find(par, x):
    while par[x] != x:
        par[x] = par[par[x]]; x = par[x]
    return x

def main(src, dst, S=2048, pad=8):
    j, binb = read_glb(src)
    prim = j['meshes'][0]['primitives'][0]
    uv = acc_data(j, binb, prim['attributes']['TEXCOORD_0']).astype(np.float64)
    idx = acc_data(j, binb, prim['indices']).reshape(-1, 3)
    img_i = j['textures'][j['materials'][prim['material']]['pbrMetallicRoughness']['baseColorTexture']['index']]['source']
    bv = j['bufferViews'][j['images'][img_i]['bufferView']]
    src_img = Image.open(io.BytesIO(bytes(binb[bv.get('byteOffset', 0): bv.get('byteOffset', 0) + bv['byteLength']]))).convert('RGB')
    W, H = src_img.size
    # 섬 = 삼각형으로 연결된 정점 묶음 (UV 이음매에서는 정점이 나뉘어 있음)
    nv = len(uv); par = np.arange(nv)
    for a, b, c in idx:
        ra, rb, rc = find(par, a), find(par, b), find(par, c)
        par[rb] = ra; par[find(par, rc)] = ra
    roots = np.array([find(par, i) for i in range(nv)])
    ids, vlabel = np.unique(roots, return_inverse=True)
    tlabel = vlabel[idx[:, 0]]
    nI = len(ids)
    px = uv * np.array([W, H])
    rects = []
    for k in range(nI):
        vs = np.where(vlabel == k)[0]
        x0, y0 = np.floor(px[vs].min(0)) - 1; x1, y1 = np.ceil(px[vs].max(0)) + 1
        x0, y0 = max(0, x0), max(0, y0); x1, y1 = min(W, x1), min(H, y1)
        rects.append([k, int(x0), int(y0), int(max(1, x1 - x0)), int(max(1, y1 - y0))])
    # 배율 s 를 줄여가며 선반(shelf) 배치가 S×S 에 들어갈 때까지
    def pack(s):
        order = sorted(rects, key=lambda r: -r[4]); place = {}
        x = y = rowh = 0
        for k, rx, ry, rw, rh in order:
            w = int(np.ceil(rw * s)) + 2 * pad; h = int(np.ceil(rh * s)) + 2 * pad
            if x + w > S: x = 0; y += rowh; rowh = 0
            if y + h > S: return None
            place[k] = (x + pad, y + pad); x += w; rowh = max(rowh, h)
        return place
    s = 1.0
    while True:
        place = pack(s)
        if place: break
        s *= 0.95
    out = np.zeros((S, S, 3), np.float32); filled = np.zeros((S, S), bool)
    new_uv = uv.copy()
    for k, rx, ry, rw, rh in rects:
        dx, dy = place[k]
        dw, dh = int(np.ceil(rw * s)), int(np.ceil(rh * s))
        crop = src_img.crop((rx, ry, rx + rw, ry + rh)).resize((max(1, dw), max(1, dh)), Image.LANCZOS)
        m = Image.new('L', (max(1, dw), max(1, dh)), 0); d = ImageDraw.Draw(m)
        for t in np.where(tlabel == k)[0]:
            pts = [((px[v, 0] - rx) * s, (px[v, 1] - ry) * s) for v in idx[t]]
            d.polygon(pts, fill=255, outline=255)
        mk = np.asarray(m) > 0
        # 경계 1px 포함
        mk2 = mk.copy(); mk2[1:] |= mk[:-1]; mk2[:-1] |= mk[1:]; mk2[:, 1:] |= mk[:, :-1]; mk2[:, :-1] |= mk[:, 1:]
        ca = np.asarray(crop).astype(np.float32)
        sl = (slice(dy, dy + dh), slice(dx, dx + dw))
        out[sl][mk2] = ca[mk2]; filled[sl] |= mk2
        vs = np.where(vlabel == k)[0]
        new_uv[vs, 0] = ((px[vs, 0] - rx) * s + dx) / S
        new_uv[vs, 1] = ((px[vs, 1] - ry) * s + dy) / S
    # 여백을 바깥쪽 색으로 채우기 (pad 만큼 번짐)
    for _ in range(pad + 2):
        acc = np.zeros_like(out); cnt = np.zeros((S, S), np.float32)
        for sy, sx in ((1, 0), (-1, 0), (0, 1), (0, -1)):
            sh = np.roll(np.roll(filled, sy, 0), sx, 1); so = np.roll(np.roll(out, sy, 0), sx, 1)
            acc += so * sh[..., None]; cnt += sh
        grow = (~filled) & (cnt > 0)
        out[grow] = acc[grow] / cnt[grow][:, None]; filled |= grow
    bg = out[filled].mean(0); out[~filled] = bg
    res = Image.fromarray(np.clip(out, 0, 255).astype(np.uint8))
    buf = io.BytesIO(); res.save(buf, 'JPEG', quality=90); img_bytes = buf.getvalue()
    # BIN 끝에 새 UV·이미지 붙이고 참조 교체 (옛 데이터는 glb_compact.py 가 지움)
    def append(data):
        while len(binb) % 4: binb.append(0)
        off = len(binb); binb.extend(data); j['bufferViews'].append({'buffer': 0, 'byteOffset': off, 'byteLength': len(data)}); return len(j['bufferViews']) - 1
    uvf = new_uv.astype(np.float32)
    bvi = append(uvf.tobytes())
    j['accessors'].append({'bufferView': bvi, 'componentType': 5126, 'count': len(uvf), 'type': 'VEC2', 'min': uvf.min(0).tolist(), 'max': uvf.max(0).tolist()})
    prim['attributes']['TEXCOORD_0'] = len(j['accessors']) - 1
    j['images'][img_i] = {'bufferView': append(img_bytes), 'mimeType': 'image/jpeg'}
    while len(binb) % 4: binb.append(0)
    j['buffers'][0]['byteLength'] = len(binb)
    js = json.dumps(j, separators=(',', ':')).encode(); js += b' ' * ((4 - len(js) % 4) % 4)
    total = 12 + 8 + len(js) + 8 + len(binb)
    with open(dst, 'wb') as f:
        f.write(struct.pack('<4sII', b'glTF', 2, total)); f.write(struct.pack('<II', len(js), 0x4E4F534A)); f.write(js)
        f.write(struct.pack('<II', len(binb), 0x004E4942)); f.write(binb)
    print(f'{src}: islands={nI} scale={s:.3f} out={dst} size={total}')

if __name__ == '__main__':
    main(sys.argv[1], sys.argv[2])
