// Boot progress for the CachyOS live profile. The VGA console stays quiet for
// long stretches, so stages are inferred from the guest's serial console.
const stages=[
  {pattern:/Linux version|^\[\s*\d+\.\d+\]/,label:'Starting the Linux kernel',percent:8},
  {pattern:/:: running early hook/,label:'Running the initramfs',percent:15},
  {pattern:/Mounting '\/dev\/sr0'/,label:'Mounting the live media',percent:25},
  {pattern:/Welcome to CachyOS/,label:'Starting system services',percent:35},
  {pattern:/Reached target .*Basic System/,label:'Starting system services',percent:50},
  {pattern:/Started .*(Authorization Manager|Network Manager)/,label:'Starting system services',percent:60},
  {pattern:/Starting .*Plasma Login Manager|Reached target .*Graphical/,label:'Starting the login manager',percent:75},
  {pattern:/Started .*Plasma Login Manager|login: *$/,label:'Starting the KDE Plasma desktop',percent:85},
];
const clean=text=>text.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1bP[^\x1b]*\x1b\\|[\x00-\x08\x0b-\x1f]/g,'').trim();
const minutes=ms=>{const s=Math.floor(ms/1000);return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;};

export function createBootProgress(root){
  const stage=root.querySelector('.bp-stage'),time=root.querySelector('.bp-time');
  const bar=root.querySelector('.bp-bar'),fill=root.querySelector('.bp-fill'),detail=root.querySelector('.bp-detail');
  let started=0,timer=0,reached=-1;
  const set=(label,percent)=>{
    stage.textContent=label;
    fill.style.width=`${percent}%`;
    bar.setAttribute('aria-valuenow',String(percent));
  };
  const tick=()=>{time.textContent=minutes(performance.now()-started);};
  return {
    start(label='Loading the boot files'){
      started=performance.now();reached=-1;
      root.hidden=false;root.classList.remove('done','failed');
      set(label,2);detail.textContent='';tick();
      clearInterval(timer);timer=setInterval(tick,1000);
    },
    step(label,percent){if(started&&reached<0)set(label,percent);},
    update(lines){
      if(!started)return;
      for(const {text} of lines){
        const line=clean(text);
        if(!line)continue;
        for(let i=reached+1;i<stages.length;i++){
          if(stages[i].pattern.test(line)){reached=i;set(stages[i].label,stages[i].percent);}
        }
        if(!line.startsWith('tci-jit:'))detail.textContent=line.length>140?`${line.slice(0,137)}…`:line;
      }
    },
    finish(ok,message){
      if(!started)return;
      clearInterval(timer);tick();started=0;
      root.classList.add(ok?'done':'failed');
      set(message,ok?100:Number(bar.getAttribute('aria-valuenow'))||0);
      if(ok)detail.textContent='';
    },
    hide(){clearInterval(timer);started=0;root.hidden=true;},
  };
}
