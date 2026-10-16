"""Local reverse-engineering aid; requires capstone and pyelftools in .tools/python."""
import sys, json, re, bisect
from pathlib import Path
sys.path.insert(0, str(Path('.tools/python').resolve()))
from elftools.elf.elffile import ELFFile
from capstone import Cs, CS_ARCH_ARM64, CS_MODE_ARM
from capstone.arm64 import ARM64_OP_IMM

p=Path('.reference/native/libstreamer.so')
f=p.open('rb');elf=ELFFile(f)
segments=[(s['p_vaddr'],s.data()) for s in elf.iter_segments() if s['p_type']=='PT_LOAD']
def read(addr,n=160):
    for a,b in segments:
        if a<=addr<a+len(b):return b[addr-a:addr-a+n]
    return b''
def string(addr):
    b=read(addr).split(b'\0')[0]
    if len(b)>2 and all(32<=c<127 for c in b):return b.decode()
    return ''
starts=sorted((x['initial_location'],x['address_range']) for x in elf.get_dwarf_info().EH_CFI_entries() if x.__class__.__name__=='FDE')
addresses=[x[0] for x in starts]
text=elf.get_section_by_name('.text')
md=Cs(CS_ARCH_ARM64,CS_MODE_ARM)
regs={};result=[]
for addr,size,op,args in md.disasm_lite(text.data(),text['sh_addr']):
    aa=args.split(', ')
    try:
        if op in ('adr','adrp'):regs[aa[0]]=int(aa[1].lstrip('#'),0)
        elif op=='add' and aa[1] in regs and aa[2].startswith('#'):
            v=regs[aa[1]]+int(aa[2].lstrip('#'),0);regs[aa[0]]=v
            s=string(v)
            if s:
                i=bisect.bisect_right(addresses,addr)-1
                start,length=starts[i] if i>=0 else (0,0)
                result.append({'at':hex(addr),'function':hex(start),'size':length,'string':s})
        elif op in ('b','bl','blr','ret'):regs={}
        elif aa and op not in ('str','stp','stur','cmp','tst','nop'):regs.pop(aa[0],None)
    except (ValueError,IndexError):pass
Path('.reference/native/string-xrefs.json').write_text(json.dumps(result,indent=2),encoding='utf8')
for r in result:
    if re.search('signal connection|signal emit|signal event listener|connection header|SOAC|CONTROL_DATA_CHANNEL|TEXT_DATA_CHANNEL|streamer_push',r['string'],re.I):print(json.dumps(r))
