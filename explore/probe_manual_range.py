import time, requests, numpy as np
from astropy.io import fits
KEY="dr1/level2/2025W19_1B/l2b-v27-2026-197/3/level2_2025W19_1B_0116_1D3_spx_l2b-v27-2026-197.fits"
for name,url in [("irsa","https://irsa.ipac.caltech.edu/ibe/data/spherex/"+KEY),("s3","https://nasa-irsa-spherex.s3.amazonaws.com/"+KEY)]:
    s=requests.Session(); t0=time.time()
    try:
        r=s.get(url,headers={"Range":"bytes=0-28799"},timeout=60)
        print(name,"status",r.status_code,"len",len(r.content),"CR",r.headers.get("Content-Range"),"%.2fs"%(time.time()-t0))
        # walk HDUs
        off=0; buf=b""; hdus=[]
        def get(a,b): return s.get(url,headers={"Range":f"bytes={a}-{b-1}"},timeout=60).content
        for i in range(7):
            hb=b""
            while True:
                blk=get(off+len(hb),off+len(hb)+2880*4); hb+=blk
                if b"END"+b" "*77 in hb: break
            # find END card position
            k=0
            while hb[k*80:k*80+80].rstrip()!=b"END": k+=1
            hlen=((k+1)*80+2879)//2880*2880
            h=fits.Header.fromstring(hb[:hlen].decode("ascii"))
            n=abs(h["BITPIX"])//8 if h.get("NAXIS",0) else 0
            for a in range(1,h.get("NAXIS",0)+1): n*=h[f"NAXIS{a}"]
            n+= h.get("PCOUNT",0)
            hdus.append((h.get("EXTNAME","PRIMARY"),off,off+hlen,n)); off+=hlen+(n+2879)//2880*2880
        print(name,"walked headers %.2fs"%(time.time()-t0),hdus)
        # 31x31 cutout rows from IMAGE at x=381,y=154 (0-based) -> rows 139..169
        e,_,d0,_=hdus[1]; W=2040; t1=time.time()
        a=d0+(139*W+366)*4; b=d0+(169*W+397)*4
        raw=get(a,b); arr=np.frombuffer(raw[:((169-139)*W+31)*4],">f4")
        print(name,"row-span bytes",len(raw),"%.2fs"%(time.time()-t1))
        ranges=",".join(f"{d0+(y*W+366)*4}-{d0+(y*W+397)*4-1}" for y in range(139,170))
        t1=time.time(); r=s.get(url,headers={"Range":"bytes="+ranges},timeout=60)
        print(name,"multirange status",r.status_code,r.headers.get("Content-Type","")[:40],"bytes",len(r.content),"%.2fs"%(time.time()-t1))
    except Exception as ex: print(name,"ERR",repr(ex)[:200])
