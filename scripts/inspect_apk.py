"""Extract reference assets and Android binary XML without external dependencies."""
from pathlib import Path
import json
import struct
import zipfile

ROOT = Path(__file__).resolve().parent.parent
APK = next((ROOT / 'ref').glob('*.apk'))
OUT = ROOT / '.reference'
OUT.mkdir(exist_ok=True)

def u16(b, p): return struct.unpack_from('<H', b, p)[0]
def u32(b, p): return struct.unpack_from('<I', b, p)[0]

def pool(b, p):
    count, flags, start = u32(b, p+8), u32(b, p+16), u32(b, p+20)
    offsets = [u32(b, p+u16(b, p+2)+i*4) for i in range(count)]
    result = []
    for off in offsets:
        q = p + start + off
        if flags & 256:
            def length(q):
                v=b[q]
                return (((v&127)<<8)|b[q+1],q+2) if v&128 else (v,q+1)
            _,q=length(q); n,q=length(q)
            result.append(b[q:q+n].decode('utf-8', 'replace'))
        else:
            n=u16(b,q); q+=2
            if n&32768: n=((n&32767)<<16)|u16(b,q);q+=2
            result.append(b[q:q+n*2].decode('utf-16le','replace'))
    return result

resources={}
def value(t,v,strings):
    if t==3: return strings[v] if v<len(strings) else str(v)
    if t==1: return '@'+resources.get(v,hex(v))
    if t==18:return 'true' if v else 'false'
    if t in (28,29,30,31):return '#'+format(v,'08x')
    if t==5:
        mantissa=v&0xffffff00
        if mantissa&0x80000000:mantissa-=0x100000000
        scales=[1/256,1/32768,1/8388608,1/2147483648]
        return str(round(mantissa*scales[(v>>4)&3],3))+['px','dp','sp','pt','in','mm','?','?'][v&7]
    return str(v)

with zipfile.ZipFile(APK) as z:
    b=z.read('resources.arsc');p=u16(b,2);globals=[];entries=[]
    while p<len(b):
        t,hs,size=u16(b,p),u16(b,p+2),u32(b,p+4)
        if not size:break
        if t==1:globals=pool(b,p)
        if t==0x200:
            pid=u32(b,p+8); types=pool(b,p+u32(b,p+268));keys=pool(b,p+u32(b,p+276))
            q=p+hs
            while q<p+size:
                ct,ch,cs=u16(b,q),u16(b,q+2),u32(b,q+4)
                if not cs:break
                if ct==0x201 and not b[q+9]&1:
                    tid=b[q+8]; count=u32(b,q+12);start=u32(b,q+16)
                    config=b[q+20:q+ch]
                    default=not any(config[4:])
                    for i in range(count):
                        off=u32(b,q+ch+i*4)
                        if off==0xffffffff:continue
                        e=q+start+off
                        if e+8>len(b):continue
                        rid=(pid<<24)|(tid<<16)|i
                        name=types[tid-1]+'/'+keys[u32(b,e+4)]
                        resources[rid]=name
                        if not u16(b,e+2)&1:
                            vpos=e+u16(b,e)
                            entries.append((name,b[vpos+3],u32(b,vpos+4),default))
                q+=cs
        p+=size
    vals={}
    for name,t,v,default in entries:
        if default or name not in vals: vals[name]=value(t,v,globals)
    (OUT/'values.json').write_text(json.dumps(vals,ensure_ascii=False,indent=2),encoding='utf8')

    def xml(b):
        p=8;strings=[];lines=[];indent=0
        while p<len(b):
            t,hs,size=u16(b,p),u16(b,p+2),u32(b,p+4)
            if not size:break
            if t==1:strings=pool(b,p)
            if t==0x102:
                name=strings[u32(b,p+20)];attrs=[]
                astart=u16(b,p+24);asz=u16(b,p+26);count=u16(b,p+28)
                for i in range(count):
                    a=p+16+astart+i*asz
                    key=strings[u32(b,a+4)];raw=u32(b,a+8)
                    v=strings[raw] if raw!=0xffffffff else value(b[a+15],u32(b,a+16),strings)
                    if v.startswith('@'):v += ' ['+str(vals.get(v[1:],''))+']'
                    attrs.append(f'{key}="{v}"')
                lines.append('  '*indent+'<'+name+' '+' '.join(attrs)+'>');indent+=1
            if t==0x103:
                indent-=1;lines.append('  '*indent+'</'+strings[u32(b,p+20)]+'>')
            p+=size
        return '\n'.join(lines)

    for n in z.namelist():
        if n=='AndroidManifest.xml' or (n.startswith('res/layout/') and any(s in n for s in ['tv_','homepage'])):
            (OUT/Path(n).name).write_text(xml(z.read(n)),encoding='utf8')
    assets=ROOT/'public/assets';assets.mkdir(parents=True,exist_ok=True)
    wanted=['bg_homepage.webp','ic_tv_home_guide1.webp','ic_tv_home_guide2.webp','tv_logo_white.png','ic_tv_about_logo.png','ic_tv_gamepad.png','ic_tv_guide1.png','ic_tv_guide3.png','ic_tv_profile_about.png','ic_tv_profile_group.png','ic_tv_profile_update.png','ic_placeholder_avatar.png']
    for name in wanted:
        matches=[n for n in z.namelist() if n.endswith('/'+name)]
        if matches:
            n=max(matches,key=lambda n:z.getinfo(n).file_size)
            (assets/name).write_bytes(z.read(n))
    print('Decoded',len(vals),'resource values; extracted TV layouts and',len(list(assets.iterdir())),'assets.')
