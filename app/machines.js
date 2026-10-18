// These are guest architectures, independent of the computer running the browser.
export const architectures = [
  {id:'i386',name:'Intel / AMD 32-bit (x86)',available:true},
  {id:'x86_64',name:'Intel / AMD 64-bit (x86-64)',available:false},
  {id:'aarch64',name:'ARM 64-bit (AArch64)',available:false},
];
export const systems = [
  {id:'custom',name:'Custom / other OS',architectures:['i386','x86_64','aarch64']},
  {id:'freedos',name:'FreeDOS',architectures:['i386']},
  {id:'alpine',name:'Alpine Linux',architectures:['i386','x86_64','aarch64']},
  {id:'debian',name:'Debian 12',architectures:['i386','x86_64','aarch64']},
  {id:'ubuntu',name:'Ubuntu 24.04',architectures:['x86_64','aarch64']},
  {id:'fedora',name:'Fedora',architectures:['x86_64','aarch64']},
  {id:'windows',name:'Windows 11',architectures:['x86_64','aarch64']},
  {id:'templeos',name:'TempleOS',architectures:['x86_64'],
   fixture:{
     id:'templeos',
     name:'TempleOS V5.03',
     fileName:'TempleOSCDV5.03.ISO',
     url:'https://archive.org/download/TempleOS_ISO_Archive/TempleOSCDV5.03.ISO',
     streamUrl:'https://archive.org/cors/TempleOS_ISO_Archive/TempleOSCDV5.03.ISO',
     detailsUrl:'https://archive.org/details/TempleOS_ISO_Archive',
     size:17817600,
     sha256:'a7e2a4d940852b9680fa71ff11faf66daccd5db11741110ae43d54f72a245fdf',
     format:'iso',
     memory:512,
   }},
];
export const cdnFixtures = Object.freeze(Object.fromEntries(
  systems.filter(s => s.fixture).map(s => [s.id, s.fixture])
));
export function machineProblem(architecture,system='custom') {
  const machine=architectures.find(item=>item.id===architecture);
  const os=systems.find(item=>item.id===system);
  if(!machine||!os)return 'Unknown architecture or operating system.';
  if(!machine.available)return `${machine.name} needs a validated engine that is not included in this build.`;
  if(!os.architectures.includes(architecture))return `${os.name} requires a different guest architecture.`;
  return '';
}
export function selectedBootOptions({architecture,system,bios,disk,disc,format='raw',memory=64,serial=false}) {
  const problem=machineProblem(architecture,system);
  if(problem)throw new Error(problem);
  if(!bios)throw new Error('Choose a local PC BIOS to begin.');
  const sys=systems.find(item=>item.id===system);
  const effectiveDisc=disc||(sys?.fixture?.streamUrl?sys.fixture:null);
  return {
    architecture,
    files:{bios,...(disk?{hdd:disk}:{}),...(effectiveDisc?{disc:effectiveDisc}:{} )},
    settings:{cpu:'pentium3',diskFormat:format,memory:Number(memory)},
    // The pinned runtime disables its default serial port; add COM1 explicitly.
    args:[...(effectiveDisc?['-boot','order=dc']:[]),...(serial?['-chardev','stdio,id=console','-device','isa-serial,chardev=console,index=0']:[])],
  };
}
