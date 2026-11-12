/* 生成托盘与窗口图标（纯 Node，无外部依赖） */
const zlib=require('zlib'),fs=require('fs'),path=require('path');
let T=null;
function crc32(buf){if(!T){T=[];for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xEDB88320^(c>>>1):c>>>1;T[n]=c>>>0;}}let c=0xffffffff;for(const b of buf)c=T[(c^b)&255]^(c>>>8);return(c^0xffffffff)>>>0;}
function chunk(type,data){const len=Buffer.alloc(4);len.writeUInt32BE(data.length);const t=Buffer.from(type,'ascii');const crc=Buffer.alloc(4);crc.writeUInt32BE(crc32(Buffer.concat([t,data])));return Buffer.concat([len,t,data,crc]);}
function png(w,h,px,file){const raw=Buffer.alloc((w*4+1)*h);for(let y=0;y<h;y++){raw[y*(w*4+1)]=0;px.copy(raw,y*(w*4+1)+1,y*w*4,(y+1)*w*4);}const ih=Buffer.alloc(13);ih.writeUInt32BE(w,0);ih.writeUInt32BE(h,4);ih[8]=8;ih[9]=6;const head=Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',ih),chunk('IDAT',zlib.deflateSync(raw,{level:9})),chunk('IEND',Buffer.alloc(0))]);fs.writeFileSync(file,head);}
const mix=(a,b,t)=>a.map((v,i)=>Math.round(v+(b[i]-v)*t));
const smooth=(e,x)=>Math.max(0,Math.min(1,(x+e)/(2*e)));
function make(S){
  const px=Buffer.alloc(S*S*4);
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){
    const u=(x+0.5)/S,v=(y+0.5)/S;
    // 圆角方形背景
    const r=0.20,dx=Math.max(r-u,u-(1-r),0),dy=Math.max(r-v,v-(1-r),0);
    const inRect=1-smooth(0.008,Math.hypot(dx,dy)-r+0.008);
    let c=[14,16,23,0];
    const bg=[24,27,38,255];
    c=mix(c,bg,inRect);
    // 唱片圆环
    const d=Math.hypot(u-0.5,v-0.5);
    const ring=smooth(0.006,d-0.30)*(1-smooth(0.006,d-0.385));
    c=mix(c,[251,114,153,255],ring*inRect);
    // 内盘
    const inner=(1-smooth(0.006,d-0.255))*inRect;
    c=mix(c,[32,36,49,255],inner*0.96);
    // 播放三角
    const tx=u-0.455,ty=v-0.5;
    const inTri=(tx>=-0.055&&tx<=0.10&&Math.abs(ty)<=(0.085-(tx+0.055)*0.54));
    c=mix(c,[255,255,255,255],inTri?smooth(0.004,0.004):0);
    // 中心点
    const dot=(1-smooth(0.004,d-0.025))*inRect;
    c=mix(c,[251,114,153,255],dot*0.0);
    const o=(y*S+x)*4;px[o]=c[0];px[o+1]=c[1];px[o+2]=c[2];px[o+3]=c[3];
  }
  return px;
}
const out=path.join(__dirname,'..','assets');
png(256,256,make(256),path.join(out,'icon.png'));
png(64,64,make(64),path.join(out,'tray.png'));
console.log('icons written');
