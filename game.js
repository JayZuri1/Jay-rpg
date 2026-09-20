import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getAuth, createUserWithEmailAndPassword, signInWithEmailAndPassword, signOut, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-auth.js";
import { getDatabase, ref, set, update, onValue, onDisconnect, remove } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";

const firebaseConfig = {
  databaseURL: "https://jay-rpg-default-rtdb.asia-southeast1.firebasedatabase.app",
  apiKey: "AIzaSyCdBQCQ4YoKwMHOuAwvSfyQGjN-5WC0GWU",
  authDomain: "jay-rpg.firebaseapp.com",
  projectId: "jay-rpg",
  storageBucket: "jay-rpg.firebasestorage.app",
  messagingSenderId: "1095865550264",
  appId: "1:1095865550264:web:91623fc32e34821104bb4d",
  measurementId: "G-9GXWH4GLC9"
};

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getDatabase(firebaseApp);

let currentUser=null, cloudLoaded=false, playerName="Adventurer";
let gameStarted=false;
let remotePlayers={};
let onlineSyncTimer=null;
let playersListenerStarted=false;
let playersUnsub=null;

// ---- On-screen network debug (works on phones, no console needed) ----
const net={conn:"?",writeOkAt:0,writeErr:"",read:"waiting",total:0,others:0};
const netDebug=document.createElement("div");
netDebug.style.cssText="position:fixed;left:14px;top:130px;z-index:50;background:rgba(0,0,0,.78);color:#8ff0b0;font:11px monospace;padding:6px 8px;border-radius:6px;pointer-events:none;max-width:300px;white-space:pre-wrap;display:none";
document.body.appendChild(netDebug);
setInterval(()=>{
  if(!gameStarted||!currentUser){netDebug.style.display="none";return}
  netDebug.style.display="block";
  const ago=net.writeOkAt?Math.round((Date.now()-net.writeOkAt)/1000)+"s ago":"never confirmed";
  const w=net.writeErr?("ERR "+net.writeErr):("OK "+ago);
  const bad=net.writeErr||/ERR/.test(net.read)||net.conn===false||(!net.writeOkAt&&!net.writeErr);
  netDebug.style.color=bad?"#ff9a9a":"#8ff0b0";
  netDebug.textContent=`NET DEBUG\nconnected: ${net.conn}\nmy write: ${w}\nread: ${net.read}\nplayers in DB: ${net.total} (others: ${net.others})\nme: ${currentUser.uid.slice(0,6)}`;
},1000);
let connUnsub=null;

const authScreen=document.getElementById("authScreen");
const authEmail=document.getElementById("authEmail");
const authPassword=document.getElementById("authPassword");
const authName=document.getElementById("authName");
const authMessage=document.getElementById("authMessage");
const loginBtn=document.getElementById("loginBtn");
const registerBtn=document.getElementById("registerBtn");
const logoutBtn=document.getElementById("logoutBtn");

function authMsg(t){if(authMessage)authMessage.textContent=t}
function authError(e){
  const code=e?.code||"";
  const messages={
    "auth/invalid-email":"That email address is invalid.",
    "auth/missing-password":"Enter your password.",
    "auth/email-already-in-use":"That email is already registered. Try Login.",
    "auth/weak-password":"Password must be at least 6 characters.",
    "auth/invalid-credential":"Incorrect email or password.",
    "auth/user-not-found":"Incorrect email or password.",
    "auth/wrong-password":"Incorrect email or password.",
    "auth/too-many-requests":"Too many attempts. Try again later.",
    "auth/network-request-failed":"Network error. Check your internet connection.",
    "auth/operation-not-allowed":"Email/Password sign-in is not enabled in Firebase Authentication.",
    "auth/invalid-api-key":"Firebase API key is invalid. Check the Firebase web app config.",
    "auth/app-not-authorized":"This website is not authorized for this Firebase project. Add localhost/GitHub Pages to Authorized domains.",
    "auth/internal-error":"Firebase returned an internal error. Try again in a moment."
  };
  return messages[code]||e?.message?.replace(/^Firebase:\s*/i,"")||"Authentication failed.";
}

function setAuthBusy(busy){
  loginBtn.disabled=busy; registerBtn.disabled=busy;
  loginBtn.textContent=busy?"Please wait…":"Login";
  registerBtn.textContent=busy?"Please wait…":"Register";
}

async function registerAccount(){
  if(!authEmail.value.trim()||authPassword.value.length<6){authMsg("Enter an email and a password with at least 6 characters.");return}
  setAuthBusy(true); authMsg("Creating account…");
  try{
    const name=authName.value.trim()||"Adventurer";
    const email=authEmail.value.trim();
    const password=authPassword.value;
    const cred=await createUserWithEmailAndPassword(auth,email,password);
    playerName=name;
    // Auth success is enough to enter the game. Cloud profile save is background work.
    startGameForUser(cred.user);
    set(ref(db,`characters/${cred.user.uid}/profile`),{name}).catch(e=>console.warn("Profile save failed",e));
  }catch(e){authMsg(authError(e));setAuthBusy(false)}
}

async function loginAccount(){
  if(!authEmail.value.trim()||!authPassword.value){authMsg("Enter your email and password.");return}
  setAuthBusy(true); authMsg("Logging in…");
  try{
    const email=authEmail.value.trim();
    const password=authPassword.value;
    const cred=await signInWithEmailAndPassword(auth,email,password);
    // Never wait for Realtime Database before opening the game.
    startGameForUser(cred.user);
    loadCloudCharacter(cred.user).catch(e=>console.warn("Cloud load failed",e));
  }catch(e){authMsg(authError(e));setAuthBusy(false)}
}

async function logoutRPG(){
  stopGame();
  try{await signOut(auth)}catch(e){console.warn(e)}
}
window.logoutRPG=logoutRPG;

function fetchCharacterOnce(uid){
  return new Promise(resolve=>{
    let done=false;
    const finish=v=>{if(done)return;done=true;resolve(v)};
    const timer=setTimeout(()=>finish(null),5000);
    onValue(ref(db,`characters/${uid}`),snap=>{clearTimeout(timer);finish(snap.val())},{onlyOnce:true});
  });
}


async function loadCloudCharacter(user=currentUser){
  if(!user || cloudLoaded) return;
  cloudLoaded=true;
  try{
    const data=await fetchCharacterOnce(user.uid);
    if(data){
      if(data.player) Object.assign(player,data.player);
      if(data.equipment) Object.assign(equipment,data.equipment);
      if(Array.isArray(data.inventory)){
        inventory.length=0;
        data.inventory.forEach(i=>inventory.push(i));
      }
      if("activeQuestId" in data) activeQuestId=data.activeQuestId ?? null;
      if(Array.isArray(data.quests)){
        data.quests.forEach(saved=>{
          const q=questList.find(x=>x.id===saved.id);
          if(q){q.progress=saved.progress||0;q.done=!!saved.done;}
        });
      }
      if(data.profile?.name) playerName=data.profile.name;
      fixVitals();
      updateUI();
    }else{
      await saveGame();
    }
  }catch(e){
    console.warn("Cloud character load failed:",e);
  }
}

function maxHP(){
  return derived().maxHp;
}

function inPvpArena(){
  const tx=Math.floor(player.x/TILE);
  const ty=Math.floor(player.y/TILE);
  return tx>=pvpArena.x1 && tx<=pvpArena.x2 &&
         ty>=pvpArena.y1 && ty<=pvpArena.y2;
}

function startGameForUser(user){
  currentUser=user;
  if(!gameStarted) startGame();
  authScreen.style.display="none";
  logoutBtn.style.display="block";
  document.getElementById("onlineStatus").textContent="ONLINE";

  // Listen for other players only after authentication succeeds.
  if(!playersListenerStarted){
    playersListenerStarted=true;
    playersUnsub=onValue(ref(db,"players"),snap=>{
      remotePlayers=snap.val()||{};
      net.read="OK";net.total=Object.keys(remotePlayers).length;
      const others=Object.keys(remotePlayers).filter(id=>id!==currentUser?.uid).length;
      net.others=others;
      const st=document.getElementById("onlineStatus");
      if(st)st.textContent=others?`ONLINE · ${others} other player${others>1?"s":""}`:"ONLINE";
    },err=>{
      console.warn("Player sync failed:",err);
      net.read="ERR "+(err.code||err.message);
      playersListenerStarted=false; // allow re-attaching on next login
      playersUnsub=null;
      showMessage("Can't read other players (check Firebase database rules).");
    });
  }

  if(!onlineSyncTimer){
    onlineSyncTimer=setInterval(()=>{
      if(!currentUser || !gameStarted) return;
      const tx=Math.floor(player.x/TILE),ty=Math.floor(player.y/TILE);
      set(ref(db,`players/${currentUser.uid}`),{
        name:playerName,
        x:player.x,
        y:player.y,
        level:player.level,
        hp:player.hp,
        maxHp:maxHP(),
        inArena:inPvpArena(),
        lastSeen:Date.now()
      }).then(()=>{net.writeOkAt=Date.now();net.writeErr=""})
        .catch(e=>{console.warn("Presence sync failed:",e);net.writeErr=e.code||e.message});
    },250);
  }

  // Re-register the disconnect cleanup every time the connection (re)opens,
  // because the server only runs each onDisconnect handler once.
  if(!connUnsub){
    connUnsub=onValue(ref(db,".info/connected"),snap=>{
      net.conn=snap.val();
      if(snap.val()===true && currentUser){
        onDisconnect(ref(db,`players/${currentUser.uid}`)).remove().catch(()=>{});
      }
    });
  }
}

function drawRemotePlayers(){
  for(const [uid,p] of Object.entries(remotePlayers)){
    if(uid===currentUser?.uid||!p||typeof p.x!=="number"||typeof p.y!=="number")continue;
    if(Date.now()-(p.lastSeen||0)>30000)continue; // hide stale/ghost players
    const x=p.x-camera.x,y=p.y-camera.y;
    if(x<-50||y<-50||x>canvas.width+50||y>canvas.height+50)continue;
    ctx.fillStyle="rgba(0,0,0,.35)";ctx.beginPath();ctx.ellipse(x,y+18,15,6,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.inArena?"#d84e72":"#4776b8";ctx.fillRect(x-12,y-9,24,28);
    ctx.fillStyle="#e5ae87";ctx.fillRect(x-10,y-25,20,18);
    ctx.fillStyle="#33251f";ctx.fillRect(x-11,y-27,22,8);
    ctx.fillStyle="#fff";ctx.font="bold 11px Arial";ctx.textAlign="center";ctx.fillText(`${p.name||"Player"} Lv.${p.level||1}`,x,y-34);
    if(p.inArena){ctx.fillStyle="#ff5577";ctx.font="9px Arial";ctx.fillText("PVP",x,y+42)}
  }
}
function remotePlayerAtRange(){
  if(!inPvpArena())return null;
  let best=null,bestD=72;
  for(const [uid,p] of Object.entries(remotePlayers)){
    if(!p||uid===currentUser?.uid||!p.inArena||Date.now()-(p.lastSeen||0)>30000)continue;
    const d=Math.hypot(player.x-p.x,player.y-p.y);
    if(d<bestD){best={uid,...p};bestD=d}
  }
  return best;
}
async function damageRemote(target,dmg){
  if(!currentUser||!inPvpArena()||!target.inArena)return;
  const targetRef=ref(db,`players/${target.uid}`);
  await update(targetRef,{hp:Math.max(0,(target.hp||0)-dmg),lastHitBy:currentUser.uid,lastHitAt:Date.now()});
  floating(dmg,target.x,target.y,"PVP");
}

const canvas=document.getElementById("gameCanvas"),ctx=canvas.getContext("2d");
const mini=document.getElementById("miniCanvas"),mctx=mini.getContext("2d");ctx.imageSmoothingEnabled=false;mctx.imageSmoothingEnabled=false;
function resize(){canvas.width=innerWidth;canvas.height=innerHeight}resize();addEventListener("resize",resize);

const TILE=48,MW=120,MH=90,MAX_LEVEL=255;
const map=Array.from({length:MH},()=>Array(MW).fill("grass"));
const pvpArena={id:"pvpArena",name:"PvP Arena",x1:6,y1:6,x2:30,y2:13,color:"#7a4d62",mob:null,level:1};
const zones=[
 {id:"greenwood",name:"Greenwood Village",x1:5,y1:5,x2:34,y2:28,color:"#4f954b",mob:"slime",level:1},
 {id:"dustfall",name:"Dustfall Desert",x1:38,y1:5,x2:68,y2:30,color:"#b89058",mob:"scorpion",level:20},
 {id:"frostpeak",name:"Frostpeak",x1:74,y1:4,x2:112,y2:28,color:"#8cb5c6",mob:"wolf",level:50},
 {id:"ember",name:"Emberlands",x1:35,y1:38,x2:68,y2:75,color:"#9a553e",mob:"orc",level:90},
 {id:"shadow",name:"Shadow Ruins",x1:76,y1:38,x2:115,y2:82,color:"#51485e",mob:"wraith",level:140},
 {id:"wilds",name:"Ancient Wilds",x1:5,y1:42,x2:28,y2:82,color:"#52744a",mob:"goblin",level:170}
];
function zoneAt(x,y){
 let tx=Math.floor(x/TILE),ty=Math.floor(y/TILE);
 if(tx>=pvpArena.x1&&tx<=pvpArena.x2&&ty>=pvpArena.y1&&ty<=pvpArena.y2)return pvpArena;
 return zones.find(z=>tx>=z.x1&&tx<=z.x2&&ty>=z.y1&&ty<=z.y2)||zones[0];
}
for(let y=0;y<MH;y++)for(let x=0;x<MW;x++){
 let z=zoneAt(x*TILE,y*TILE); map[y][x]=z.color;
 if(x===0||y===0||x===MW-1||y===MH-1)map[y][x]="#326b83";
}
for(let x=30;x<36;x++)for(let y=0;y<MH;y++)map[y][x]="#326b83";
for(let x=69;x<73;x++)for(let y=0;y<MH;y++)map[y][x]="#326b83";
for(let y=32;y<37;y++)for(let x=0;x<MW;x++)map[y][x]="#326b83";

// Bridges: the three rivers above used to run the full width/height of the
// map with no crossings, walling every zone off from every other one. These
// carve walkable paths through them so the whole map is actually reachable.
const BRIDGE_COLOR="#8b6b3d";
const bridges=[
 {x1:30,x2:35,y1:13,y2:19},  // Greenwood <-> Dustfall (top row, across x-river)
 {x1:30,x2:35,y1:53,y2:59},  // Ancient Wilds <-> Emberlands (bottom row, across x-river)
 {x1:69,x2:72,y1:11,y2:17},  // Dustfall <-> Frostpeak (top row, across x-river)
 {x1:69,x2:72,y1:53,y2:59},  // Emberlands <-> Shadow Ruins (bottom row, across x-river)
 {x1:14,x2:18,y1:32,y2:36},  // Greenwood <-> Ancient Wilds (left column, across y-river)
 {x1:48,x2:52,y1:32,y2:36},  // Dustfall <-> Emberlands (mid column, across y-river)
 {x1:90,x2:94,y1:32,y2:36}   // Frostpeak <-> Shadow Ruins (right column, across y-river)
];
for(const b of bridges)for(let y=b.y1;y<=b.y2;y++)for(let x=b.x1;x<=b.x2;x++)map[y][x]=BRIDGE_COLOR;
function onBridge(tx,ty){return bridges.some(b=>tx>=b.x1&&tx<=b.x2&&ty>=b.y1&&ty<=b.y2)}

const player={x:18*TILE,y:18*TILE,size:28,level:1,exp:0,gold:25,hp:100,sp:50,statPoints:0,
 stats:{str:5,agi:5,vit:5,dex:5,int:5,luk:5},direction:"down",moving:false,anim:0,attackCooldown:0,attacking:false,attackFrame:0};
const equipment={weapon:null,armor:null,helmet:null,shield:null,boots:null,accessory:null};
const inventory=[];
const items=[
 {id:"rusty_sword",name:"Rusty Sword",slot:"weapon",cat:"weapon",rarity:"Common",price:30,stats:{atk:8}},
 {id:"iron_sword",name:"Iron Sword",slot:"weapon",cat:"weapon",rarity:"Common",price:180,stats:{atk:16,str:1}},
 {id:"knight_blade",name:"Knight Blade",slot:"weapon",cat:"weapon",rarity:"Rare",price:900,stats:{atk:34,str:3,dex:2}},
 {id:"flame_saber",name:"Flame Saber",slot:"weapon",cat:"weapon",rarity:"Epic",price:4200,stats:{atk:65,str:7,luk:3}},
 {id:"shadow_fang",name:"Shadow Fang",slot:"weapon",cat:"weapon",rarity:"Legendary",price:15000,stats:{atk:110,agi:8,luk:8}},
 {id:"cloth_tunic",name:"Cloth Tunic",slot:"armor",cat:"equipment",rarity:"Common",price:40,stats:{def:3,hp:10}},
 {id:"leather_armor",name:"Leather Armor",slot:"armor",cat:"equipment",rarity:"Common",price:220,stats:{def:7,hp:25,agi:1}},
 {id:"knight_mail",name:"Knight Mail",slot:"armor",cat:"equipment",rarity:"Rare",price:1400,stats:{def:22,hp:90,vit:4}},
 {id:"ember_plate",name:"Ember Plate",slot:"armor",cat:"equipment",rarity:"Epic",price:7000,stats:{def:48,hp:180,vit:8,str:4}},
 {id:"shadow_robe",name:"Shadow Robe",slot:"armor",cat:"equipment",rarity:"Legendary",price:18000,stats:{def:38,hp:160,int:10,agi:8}},
 {id:"adventurer_cap",name:"Adventurer Cap",slot:"helmet",cat:"equipment",rarity:"Common",price:35,stats:{vit:1,hp:5}},
 {id:"steel_helm",name:"Steel Helm",slot:"helmet",cat:"equipment",rarity:"Rare",price:650,stats:{def:9,vit:3,hp:30}},
 {id:"wood_shield",name:"Wooden Shield",slot:"shield",cat:"equipment",rarity:"Common",price:50,stats:{def:4}},
 {id:"tower_shield",name:"Tower Shield",slot:"shield",cat:"equipment",rarity:"Rare",price:1200,stats:{def:20,vit:4,hp:60,agi:-2}},
 {id:"simple_boots",name:"Simple Boots",slot:"boots",cat:"equipment",rarity:"Common",price:45,stats:{speed:.25}},
 {id:"swift_boots",name:"Swift Boots",slot:"boots",cat:"equipment",rarity:"Rare",price:850,stats:{speed:1.0,agi:4}},
 {id:"copper_ring",name:"Copper Ring",slot:"accessory",cat:"equipment",rarity:"Common",price:80,stats:{str:1,dex:1}},
 {id:"swift_ring",name:"Swift Ring",slot:"accessory",cat:"equipment",rarity:"Rare",price:600,stats:{agi:3,dex:2}},
 {id:"ruby_ring",name:"Ruby Ring",slot:"accessory",cat:"equipment",rarity:"Epic",price:3500,stats:{str:5,luk:3}},
 {id:"red_potion",name:"Red Potion",cat:"consumable",rarity:"Common",price:15,stats:{heal:50}},
 {id:"blue_potion",name:"Blue Potion",cat:"consumable",rarity:"Common",price:20,stats:{sp:30}},
 {id:"teleport_scroll",name:"Return Scroll",cat:"consumable",rarity:"Common",price:25,stats:{teleport:1}}
];
function item(id){return items.find(i=>i.id===id)}
function give(id,n=1){for(let i=0;i<n;i++)inventory.push(JSON.parse(JSON.stringify(item(id))))}
give("rusty_sword");give("cloth_tunic");give("adventurer_cap");give("wood_shield");give("simple_boots");give("copper_ring");give("red_potion",3);

function equipmentStats(){
 const s={atk:0,def:0,hp:0,sp:0,speed:0,str:0,agi:0,vit:0,dex:0,int:0,luk:0};
 Object.values(equipment).forEach(i=>{if(i?.stats)for(const k in i.stats)s[k]=(s[k]||0)+i.stats[k]});
 return s;
}
function derived(){
 const e=equipmentStats(),s=player.stats;
 return {
  maxHp:100+s.vit*12+(player.level-1)*10+e.hp,
  maxSp:50+s.int*8+(player.level-1)*3+e.sp,
  attack:10+s.str*3+s.dex+Math.floor(s.luk*.5)+e.atk,
  defense:s.vit*2+e.def,
  speed:4+s.agi*.08+e.speed,
  attackDelay:Math.max(7,24-Math.floor(s.agi/3)),
  crit:Math.min(35,3+s.luk*.5),
  accuracy:Math.min(98,70+s.dex*1.5),
  magic:5+s.int*4
 };
}
player.hp=derived().maxHp;player.sp=derived().maxSp;

const npc=[
 {id:"elder",name:"Elder Rowan",x:18*TILE,y:14*TILE,type:"quest"},
 {id:"blacksmith",name:"Blacksmith",x:23*TILE,y:17*TILE,type:"shop"},
 {id:"healer",name:"Healer Mira",x:14*TILE,y:21*TILE,type:"heal"},
 {id:"desert",name:"Desert Guide",x:41*TILE,y:16*TILE,type:"quest"},
 {id:"frost",name:"Frost Sage",x:82*TILE,y:13*TILE,type:"quest"},
 {id:"ember",name:"Ember Captain",x:42*TILE,y:47*TILE,type:"quest"},
 {id:"shadow",name:"Shadow Keeper",x:84*TILE,y:49*TILE,type:"quest"},
 {id:"wild",name:"Wild Hunter",x:12*TILE,y:51*TILE,type:"quest"}
];

const mobTypes={
 slime:{name:"Green Slime",hp:55,atk:8,speed:1.0,exp:25,gold:8,color:"#a34dcc"},
 scorpion:{name:"Sand Scorpion",hp:180,atk:25,speed:1.25,exp:90,gold:30,color:"#c68a3a"},
 wolf:{name:"Ice Wolf",hp:500,atk:55,speed:1.7,exp:260,gold:80,color:"#b9d9e8"},
 orc:{name:"Ember Orc",hp:1100,atk:95,speed:1.15,exp:700,gold:190,color:"#a45c3d"},
 wraith:{name:"Shadow Wraith",hp:2300,atk:170,speed:1.4,exp:1600,gold:500,color:"#806b9e"},
 goblin:{name:"Ancient Goblin",hp:3200,atk:210,speed:1.35,exp:2300,gold:700,color:"#5d9b55"}
};
const enemies=[];let mobId=1;
function spawnMob(type,x,y){
 const t=mobTypes[type],z=zones.find(q=>q.mob===type)||zones[0],lv=z.level+Math.floor(Math.random()*6);
 const scale=1+(lv-1)*.035;
 enemies.push({id:mobId++,type,x:x*TILE+24,y:y*TILE+24,size:28,hp:Math.floor(t.hp*scale),maxHp:Math.floor(t.hp*scale),atk:Math.floor(t.atk*scale),speed:t.speed,exp:Math.floor(t.exp*scale),gold:Math.floor(t.gold*scale),alive:true,attackTimer:0,respawn:0,hitFlash:0,level:lv});
}
// NOTE: randomSpawn() and the initial spawn loop are defined further down,
// after `blocked()` and the tree decorations exist, so spawns can be
// checked against the map instead of just the zone's raw rectangle.

const questList=[];
const questTemplates=[
 ["Greenwood Slime Hunt","slime",5,100],["Slime Cleanup","slime",10,180],["Slime Menace","slime",20,400],
 ["Desert Patrol","scorpion",5,500],["Scorpion Extermination","scorpion",12,1000],["Desert Champion","scorpion",25,2200],
 ["Frozen Hunt","wolf",5,1800],["Ice Wolf Pack","wolf",15,4200],["Frostpeak Guardian","wolf",30,8500],
 ["Ember Patrol","orc",5,6000],["Orc Breaker","orc",15,14000],["Emberlands War","orc",30,30000],
 ["Shadow Hunt","wraith",5,15000],["Wraith Purge","wraith",15,35000],["Shadow Ruins","wraith",30,80000],
 ["Wild Goblin Hunt","goblin",5,22000],["Ancient Goblin War","goblin",15,50000],["Wildlands Champion","goblin",30,120000]
];
let qi=1;
for(let cycle=0;cycle<6;cycle++)for(const q of questTemplates){
 const [name,type,count,exp]=q;questList.push({id:qi++,name:`${name} ${cycle+1}`
async function logoutRPG(){
  stopGame();
  try{await signOut(auth)}catch(e){console.warn(e)}
}
window.logoutRPG=logoutRPG;

function fetchCharacterOnce(uid){
  return new Promise(resolve=>{
    let done=false;
    const finish=v=>{if(done)return;done=true;resolve(v)};
    const timer=setTimeout(()=>finish(null),5000);
    onValue(ref(db,`characters/${uid}`),snap=>{clearTimeout(timer);finish(snap.val())},{onlyOnce:true});
  });
}


async function loadCloudCharacter(user=currentUser){
  if(!user || cloudLoaded) return;
  cloudLoaded=true;
  try{
    const data=await fetchCharacterOnce(user.uid);
    if(data){
      if(data.player) Object.assign(player,data.player);
      if(data.equipment) Object.assign(equipment,data.equipment);
      if(Array.isArray(data.inventory)){
        inventory.length=0;
        data.inventory.forEach(i=>inventory.push(i));
      }
      if("activeQuestId" in data) activeQuestId=data.activeQuestId ?? null;
      if(Array.isArray(data.quests)){
        data.quests.forEach(saved=>{
          const q=questList.find(x=>x.id===saved.id);
          if(q){q.progress=saved.progress||0;q.done=!!saved.done;}
        });
      }
      if(data.profile?.name) playerName=data.profile.name;
      fixVitals();
      updateUI();
    }else{
      await saveGame();
    }
  }catch(e){
    console.warn("Cloud character load failed:",e);
  }
}

function maxHP(){
  return derived().maxHp;
}

function inPvpArena(){
  const tx=Math.floor(player.x/TILE);
  const ty=Math.floor(player.y/TILE);
  return tx>=pvpArena.x1 && tx<=pvpArena.x2 &&
         ty>=pvpArena.y1 && ty<=pvpArena.y2;
}

function startGameForUser(user){
  currentUser=user;
  if(!gameStarted) startGame();
  authScreen.style.display="none";
  logoutBtn.style.display="block";
  document.getElementById("onlineStatus").textContent="ONLINE";

  // Listen for other players only after authentication succeeds.
  if(!playersListenerStarted){
    playersListenerStarted=true;
    playersUnsub=onValue(ref(db,"players"),snap=>{
      remotePlayers=snap.val()||{};
      net.read="OK";net.total=Object.keys(remotePlayers).length;
      const others=Object.keys(remotePlayers).filter(id=>id!==currentUser?.uid).length;
      net.others=others;
      const st=document.getElementById("onlineStatus");
      if(st)st.textContent=others?`ONLINE · ${others} other player${others>1?"s":""}`:"ONLINE";
    },err=>{
      console.warn("Player sync failed:",err);
      net.read="ERR "+(err.code||err.message);
      playersListenerStarted=false; // allow re-attaching on next login
      playersUnsub=null;
      showMessage("Can't read other players (check Firebase database rules).");
    });
  }

  if(!onlineSyncTimer){
    onlineSyncTimer=setInterval(()=>{
      if(!currentUser || !gameStarted) return;
      const tx=Math.floor(player.x/TILE),ty=Math.floor(player.y/TILE);
      set(ref(db,`players/${currentUser.uid}`),{
        name:playerName,
        x:player.x,
        y:player.y,
        level:player.level,
        hp:player.hp,
        maxHp:maxHP(),
        inArena:inPvpArena(),
        lastSeen:Date.now()
      }).then(()=>{net.writeOkAt=Date.now();net.writeErr=""})
        .catch(e=>{console.warn("Presence sync failed:",e);net.writeErr=e.code||e.message});
    },250);
  }

  // Re-register the disconnect cleanup every time the connection (re)opens,
  // because the server only runs each onDisconnect handler once.
  if(!connUnsub){
    connUnsub=onValue(ref(db,".info/connected"),snap=>{
      net.conn=snap.val();
      if(snap.val()===true && currentUser){
        onDisconnect(ref(db,`players/${currentUser.uid}`)).remove().catch(()=>{});
      }
    });
  }
}

function drawRemotePlayers(){
  for(const [uid,p] of Object.entries(remotePlayers)){
    if(uid===currentUser?.uid||!p||typeof p.x!=="number"||typeof p.y!=="number")continue;
    if(Date.now()-(p.lastSeen||0)>30000)continue; // hide stale/ghost players
    const x=p.x-camera.x,y=p.y-camera.y;
    if(x<-50||y<-50||x>canvas.width+50||y>canvas.height+50)continue;
    ctx.fillStyle="rgba(0,0,0,.35)";ctx.beginPath();ctx.ellipse(x,y+18,15,6,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=p.inArena?"#d84e72":"#4776b8";ctx.fillRect(x-12,y-9,24,28);
    ctx.fillStyle="#e5ae87";ctx.fillRect(x-10,y-25,20,18);
    ctx.fillStyle="#33251f";ctx.fillRect(x-11,y-27,22,8);
    ctx.fillStyle="#fff";ctx.font="bold 11px Arial";ctx.textAlign="center";ctx.fillText(`${p.name||"Player"} Lv.${p.level||1}`,x,y-34);
    if(p.inArena){ctx.fillStyle="#ff5577";ctx.font="9px Arial";ctx.fillText("PVP",x,y+42)}
  }
}
function remotePlayerAtRange(){
  if(!inPvpArena())return null;
  let best=null,bestD=72;
  for(const [uid,p] of Object.entries(remotePlayers)){
    if(!p||uid===currentUser?.uid||!p.inArena||Date.now()-(p.lastSeen||0)>30000)continue;
    const d=Math.hypot(player.x-p.x,player.y-p.y);
    if(d<bestD){best={uid,...p};bestD=d}
  }
  return best;
}
async function damageRemote(target,dmg){
  if(!currentUser||!inPvpArena()||!target.inArena)return;
  const targetRef=ref(db,`players/${target.uid}`);
  await update(targetRef,{hp:Math.max(0,(target.hp||0)-dmg),lastHitBy:currentUser.uid,lastHitAt:Date.now()});
  floating(dmg,target.x,target.y,"PVP");
}

const canvas=document.getElementById("gameCanvas"),ctx=canvas.getContext("2d");
const mini=document.getElementById("miniCanvas"),mctx=mini.getContext("2d");ctx.imageSmoothingEnabled=false;mctx.imageSmoothingEnabled=false;
function resize(){canvas.width=innerWidth;canvas.height=innerHeight}resize();addEventListener("resize",resize);

const TILE=48,MW=120,MH=90,MAX_LEVEL=255;
const map=Array.from({length:MH},()=>Array(MW).fill("grass"));
const pvpArena={id:"pvpArena",name:"PvP Arena",x1:6,y1:6,x2:30,y2:13,color:"#7a4d62",mob:null,level:1};
const zones=[
 {id:"greenwood",name:"Greenwood Village",x1:5,y1:5,x2:34,y2:28,color:"#4f954b",mob:"slime",level:1},
 {id:"dustfall",name:"Dustfall Desert",x1:38,y1:5,x2:68,y2:30,color:"#b89058",mob:"scorpion",level:20},
 {id:"frostpeak",name:"Frostpeak",x1:74,y1:4,x2:112,y2:28,color:"#8cb5c6",mob:"wolf",level:50},
 {id:"ember",name:"Emberlands",x1:35,y1:38,x2:68,y2:75,color:"#9a553e",mob:"orc",level:90},
 {id:"shadow",name:"Shadow Ruins",x1:76,y1:38,x2:115,y2:82,color:"#51485e",mob:"wraith",level:140},
 {id:"wilds",name:"Ancient Wilds",x1:5,y1:42,x2:28,y2:82,color:"#52744a",mob:"goblin",level:170}
];
function zoneAt(x,y){
 let tx=Math.floor(x/TILE),ty=Math.floor(y/TILE);
 if(tx>=pvpArena.x1&&tx<=pvpArena.x2&&ty>=pvpArena.y1&&ty<=pvpArena.y2)return pvpArena;
 return zones.find(z=>tx>=z.x1&&tx<=z.x2&&ty>=z.y1&&ty<=z.y2)||zones[0];
}
for(let y=0;y<MH;y++)for(let x=0;x<MW;x++){
 let z=zoneAt(x*TILE,y*TILE); map[y][x]=z.color;
 if(x===0||y===0||x===MW-1||y===MH-1)map[y][x]="#326b83";
}
for(let x=30;x<36;x++)for(let y=0;y<MH;y++)map[y][x]="#326b83";
for(let x=69;x<73;x++)for(let y=0;y<MH;y++)map[y][x]="#326b83";
for(let y=32;y<37;y++)for(let x=0;x<MW;x++)map[y][x]="#326b83";

// Bridges: the three rivers above used to run the full width/height of the
// map with no crossings, walling every zone off from every other one. These
// carve walkable paths through them so the whole map is actually reachable.
const BRIDGE_COLOR="#8b6b3d";
const bridges=[
 {x1:30,x2:35,y1:13,y2:19},  // Greenwood <-> Dustfall (top row, across x-river)
 {x1:30,x2:35,y1:53,y2:59},  // Ancient Wilds <-> Emberlands (bottom row, across x-river)
 {x1:69,x2:72,y1:11,y2:17},  // Dustfall <-> Frostpeak (top row, across x-river)
 {x1:69,x2:72,y1:53,y2:59},  // Emberlands <-> Shadow Ruins (bottom row, across x-river)
 {x1:14,x2:18,y1:32,y2:36},  // Greenwood <-> Ancient Wilds (left column, across y-river)
 {x1:48,x2:52,y1:32,y2:36},  // Dustfall <-> Emberlands (mid column, across y-river)
 {x1:90,x2:94,y1:32,y2:36}   // Frostpeak <-> Shadow Ruins (right column, across y-river)
];
for(const b of bridges)for(let y=b.y1;y<=b.y2;y++)for(let x=b.x1;x<=b.x2;x++)map[y][x]=BRIDGE_COLOR;
function onBridge(tx,ty){return bridges.some(b=>tx>=b.x1&&tx<=b.x2&&ty>=b.y1&&ty<=b.y2)}

const player={x:18*TILE,y:18*TILE,size:28,level:1,exp:0,gold:25,hp:100,sp:50,statPoints:0,
 stats:{str:5,agi:5,vit:5,dex:5,int:5,luk:5},direction:"down",moving:false,anim:0,attackCooldown:0,attacking:false,attackFrame:0};
const equipment={weapon:null,armor:null,helmet:null,shield:null,boots:null,accessory:null};
const inventory=[];
const items=[
 {id:"rusty_sword",name:"Rusty Sword",slot:"weapon",cat:"weapon",rarity:"Common",price:30,stats:{atk:8}},
 {id:"iron_sword",name:"Iron Sword",slot:"weapon",cat:"weapon",rarity:"Common",price:180,stats:{atk:16,str:1}},
 {id:"knight_blade",name:"Knight Blade",slot:"weapon",cat:"weapon",rarity:"Rare",price:900,stats:{atk:34,str:3,dex:2}},
 {id:"flame_saber",name:"Flame Saber",slot:"weapon",cat:"weapon",rarity:"Epic",price:4200,stats:{atk:65,str:7,luk:3}},
 {id:"shadow_fang",name:"Shadow Fang",slot:"weapon",cat:"weapon",rarity:"Legendary",price:15000,stats:{atk:110,agi:8,luk:8}},
 {id:"cloth_tunic",name:"Cloth Tunic",slot:"armor",cat:"equipment",rarity:"Common",price:40,stats:{def:3,hp:10}},
 {id:"leather_armor",name:"Leather Armor",slot:"armor",cat:"equipment",rarity:"Common",price:220,stats:{def:7,hp:25,agi:1}},
 {id:"knight_mail",name:"Knight Mail",slot:"armor",cat:"equipment",rarity:"Rare",price:1400,stats:{def:22,hp:90,vit:4}},
 {id:"ember_plate",name:"Ember Plate",slot:"armor",cat:"equipment",rarity:"Epic",price:7000,stats:{def:48,hp:180,vit:8,str:4}},
 {id:"shadow_robe",name:"Shadow Robe",slot:"armor",cat:"equipment",rarity:"Legendary",price:18000,stats:{def:38,hp:160,int:10,agi:8}},
 {id:"adventurer_cap",name:"Adventurer Cap",slot:"helmet",cat:"equipment",rarity:"Common",price:35,stats:{vit:1,hp:5}},
 {id:"steel_helm",name:"Steel Helm",slot:"helmet",cat:"equipment",rarity:"Rare",price:650,stats:{def:9,vit:3,hp:30}},
 {id:"wood_shield",name:"Wooden Shield",slot:"shield",cat:"equipment",rarity:"Common",price:50,stats:{def:4}},
 {id:"tower_shield",name:"Tower Shield",slot:"shield",cat:"equipment",rarity:"Rare",price:1200,stats:{def:20,vit:4,hp:60,agi:-2}},
 {id:"simple_boots",name:"Simple Boots",slot:"boots",cat:"equipment",rarity:"Common",price:45,stats:{speed:.25}},
 {id:"swift_boots",name:"Swift Boots",slot:"boots",cat:"equipment",rarity:"Rare",price:850,stats:{speed:1.0,agi:4}},
 {id:"copper_ring",name:"Copper Ring",slot:"accessory",cat:"equipment",rarity:"Common",price:80,stats:{str:1,dex:1}},
 {id:"swift_ring",name:"Swift Ring",slot:"accessory",cat:"equipment",rarity:"Rare",price:600,stats:{agi:3,dex:2}},
 {id:"ruby_ring",name:"Ruby Ring",slot:"accessory",cat:"equipment",rarity:"Epic",price:3500,stats:{str:5,luk:3}},
 {id:"red_potion",name:"Red Potion",cat:"consumable",rarity:"Common",price:15,stats:{heal:50}},
 {id:"blue_potion",name:"Blue Potion",cat:"consumable",rarity:"Common",price:20,stats:{sp:30}},
 {id:"teleport_scroll",name:"Return Scroll",cat:"consumable",rarity:"Common",price:25,stats:{teleport:1}}
];
function item(id){return items.find(i=>i.id===id)}
function give(id,n=1){for(let i=0;i<n;i++)inventory.push(JSON.parse(JSON.stringify(item(id))))}
give("rusty_sword");give("cloth_tunic");give("adventurer_cap");give("wood_shield");give("simple_boots");give("copper_ring");give("red_potion",3);

function equipmentStats(){
 const s={atk:0,def:0,hp:0,sp:0,speed:0,str:0,agi:0,vit:0,dex:0,int:0,luk:0};
 Object.values(equipment).forEach(i=>{if(i?.stats)for(const k in i.stats)s[k]=(s[k]||0)+i.stats[k]});
 return s;
}
function derived(){
 const e=equipmentStats(),s=player.stats;
 return {
  maxHp:100+s.vit*12+(player.level-1)*10+e.hp,
  maxSp:50+s.int*8+(player.level-1)*3+e.sp,
  attack:10+s.str*3+s.dex+Math.floor(s.luk*.5)+e.atk,
  defense:s.vit*2+e.def,
  speed:4+s.agi*.08+e.speed,
  attackDelay:Math.max(7,24-Math.floor(s.agi/3)),
  crit:Math.min(35,3+s.luk*.5),
  accuracy:Math.min(98,70+s.dex*1.5),
  magic:5+s.int*4
 };
}
player.hp=derived().maxHp;player.sp=derived().maxSp;

const npc=[
 {id:"elder",name:"Elder Rowan",x:18*TILE,y:14*TILE,type:"quest"},
 {id:"blacksmith",name:"Blacksmith",x:23*TILE,y:17*TILE,type:"shop"},
 {id:"healer",name:"Healer Mira",x:14*TILE,y:21*TILE,type:"heal"},
 {id:"desert",name:"Desert Guide",x:41*TILE,y:16*TILE,type:"quest"},
 {id:"frost",name:"Frost Sage",x:82*TILE,y:13*TILE,type:"quest"},
 {id:"ember",name:"Ember Captain",x:42*TILE,y:47*TILE,type:"quest"},
 {id:"shadow",name:"Shadow Keeper",x:84*TILE,y:49*TILE,type:"quest"},
 {id:"wild",name:"Wild Hunter",x:12*TILE,y:51*TILE,type:"quest"}
];

const mobTypes={
 slime:{name:"Green Slime",hp:55,atk:8,speed:1.0,exp:25,gold:8,color:"#a34dcc"},
 scorpion:{name:"Sand Scorpion",hp:180,atk:25,speed:1.25,exp:90,gold:30,color:"#c68a3a"},
 wolf:{name:"Ice Wolf",hp:500,atk:55,speed:1.7,exp:260,gold:80,color:"#b9d9e8"},
 orc:{name:"Ember Orc",hp:1100,atk:95,speed:1.15,exp:700,gold:190,color:"#a45c3d"},
 wraith:{name:"Shadow Wraith",hp:2300,atk:170,speed:1.4,exp:1600,gold:500,color:"#806b9e"},
 goblin:{name:"Ancient Goblin",hp:3200,atk:210,speed:1.35,exp:2300,gold:700,color:"#5d9b55"}
};
const enemies=[];let mobId=1;
function spawnMob(type,x,y){
 const t=mobTypes[type],z=zones.find(q=>q.mob===type)||zones[0],lv=z.level+Math.floor(Math.random()*6);
 const scale=1+(lv-1)*.035;
 enemies.push({id:mobId++,type,x:x*TILE+24,y:y*TILE+24,size:28,hp:Math.floor(t.hp*scale),maxHp:Math.floor(t.hp*scale),atk:Math.floor(t.atk*scale),speed:t.speed,exp:Math.floor(t.exp*scale),gold:Math.floor(t.gold*scale),alive:true,attackTimer:0,respawn:0,hitFlash:0,level:lv});
}
// NOTE: randomSpawn() and the initial spawn loop are defined further down,
// after `blocked()` and the tree decorations exist, so spawns can be
// checked against the map instead of just the zone's raw rectangle.

const questList=[];
const questTemplates=[
 ["Greenwood Slime Hunt","slime",5,100],["Slime Cleanup","slime",10,180],["Slime Menace","slime",20,400],
 ["Desert Patrol","scorpion",5,500],["Scorpion Extermination","scorpion",12,1000],["Desert Champion","scorpion",25,2200],
 ["Frozen Hunt","wolf",5,1800],["Ice Wolf Pack","wolf",15,4200],["Frostpeak Guardian","wolf",30,8500],
 ["Ember Patrol","orc",5,6000],["Orc Breaker","orc",15,14000],["Emberlands War","orc",30,30000],
 ["Shadow Hunt","wraith",5,15000],["Wraith Purge","wraith",15,35000],["Shadow Ruins","wraith",30,80000],
 ["Wild Goblin Hunt","goblin",5,22000],["Ancient Goblin War","goblin",15,50000],["Wildlands Champion","goblin",30,120000]
];
let qi=1;
for(let cycle=0;cycle<6;cycle++)for(const q of questTemplates){
 const [name,type,count,exp]=q;questList.push({id:qi++,name:`${name} ${cycle+1}`,type,count,exp:Math.floor(exp*(1+cycle*.55)),gold:Math.floor(exp*.35),progress:0,done:false});
}
while(questList.length<105){
 const type=["slime","scorpion","wolf","orc","wraith","goblin"][Math.floor(Math.random()*6)];
 const count=5+Math.floor(Math.random()*36),base=mobTypes[type].exp*count*2;
 questList.push({id:qi++,name:`Bounty #${qi}`,type,count,exp:base,gold:Math.floor(base*.3),progress:0,done:false});
}
let activeQuestId=null;

const camera={x:0,y:0},keys={};
function typingInField(){
 const el=document.activeElement;
 return !!el && (el.tagName==="INPUT"||el.tagName==="TEXTAREA"||el.tagName==="SELECT"||el.isContentEditable);
}
addEventListener("keydown",e=>{
 if(!gameStarted||authScreen.style.display!=="none"||typingInField())return;
 const k=e.key.toLowerCase();
 keys[k]=true;
 if(e.code==="Space"){attack();e.preventDefault();return}
 if(k==="e"){interact();e.preventDefault();return}
 if(k==="i"){togglePanel("inventoryPanel");e.preventDefault();return}
 if(k==="c"){togglePanel("characterPanel");e.preventDefault();return}
 if(k==="m"){toggleMap();e.preventDefault();return}
});
addEventListener("keyup",e=>{if(typingInField())return;keys[e.key.toLowerCase()]=false});
canvas.addEventListener("pointerdown",()=>{if(gameStarted)initAudio()});

let audioContext=null;
function initAudio(){if(!audioContext)audioContext=new(window.AudioContext||window.webkitAudioContext)();if(audioContext.state==="suspended")audioContext.resume()}

// Plays a single synthesized tone. f2 (optional) makes the pitch glide from
// f to f2 over the tone's duration, useful for whooshes/sweeps. delay
// schedules the tone to start slightly in the future, for building small
// melodic riffs out of several calls (see sfxDefs below).
function tone(f,d,type="sine",v=.05,delay=0,f2=null){
  initAudio();
  const t0=audioContext.currentTime+delay;
  const o=audioContext.createOscillator(),g=audioContext.createGain();
  o.type=type;
  o.frequency.setValueAtTime(f,t0);
  if(f2)o.frequency.exponentialRampToValueAtTime(f2,t0+d);
  g.gain.setValueAtTime(v,t0);
  g.gain.exponentialRampToValueAtTime(.0001,t0+d);
  o.connect(g);g.connect(audioContext.destination);
  o.start(t0);o.stop(t0+d+.02);
}
// A short burst of filtered noise, layered under punchy sounds (hits,
// hurts) so they read as an impact rather than a plain beep.
function noiseBurst(d,v=.05,delay=0){
  initAudio();
  const n=Math.max(1,Math.floor(audioContext.sampleRate*d));
  const buf=audioContext.createBuffer(1,n,audioContext.sampleRate);
  const data=buf.getChannelData(0);
  for(let i=0;i<n;i++)data[i]=(Math.random()*2-1)*(1-i/n);
  const src=audioContext.createBufferSource();src.buffer=buf;
  const g=audioContext.createGain();
  const t0=audioContext.currentTime+delay;
  g.gain.setValueAtTime(v,t0);g.gain.exponentialRampToValueAtTime(.0001,t0+d);
  src.connect(g);g.connect(audioContext.destination);
  src.start(t0);
}
// Every game sound effect, as little synthesized "riffs" built from tone()
// and noiseBurst() calls. No audio files needed, so nothing to load.
const sfxDefs={
 attack:()=>tone(480,.07,"sawtooth",.05),
 hit:()=>{tone(140,.06,"square",.08);noiseBurst(.05,.05)},
 crit:()=>{tone(220,.06,"square",.1);noiseBurst(.07,.07);tone(600,.09,"sawtooth",.05,.03)},
 miss:()=>tone(320,.06,"sine",.025,0,220),
 coin:()=>{tone(880,.06,"square",.06);tone(1320,.08,"square",.05,.05)},
 hurt:()=>{tone(170,.12,"sawtooth",.06);noiseBurst(.08,.05)},
 defeat:()=>{tone(300,.2,"sawtooth",.06);tone(200,.25,"sawtooth",.05,.15);tone(110,.4,"sawtooth",.06,.3)},
 level:()=>{tone(523,.1,"sine",.06);tone(659,.1,"sine",.06,.1);tone(784,.2,"sine",.07,.2)},
 heal:()=>{tone(660,.09,"sine",.05);tone(880,.13,"sine",.05,.08)},
 questAccept:()=>{tone(440,.08,"triangle",.05);tone(660,.13,"triangle",.05,.08)},
 questComplete:()=>{tone(523,.1,"triangle",.06);tone(659,.1,"triangle",.06,.1);tone(880,.22,"triangle",.07,.2)},
 buy:()=>{tone(700,.05,"square",.04);tone(1000,.07,"square",.04,.05)},
 equip:()=>{tone(320,.05,"square",.05);tone(480,.07,"square",.04,.04)},
 unequip:()=>tone(260,.07,"square",.04),
 teleport:()=>tone(900,.25,"sine",.05,0,180),
 deny:()=>{tone(180,.09,"square",.05);tone(140,.13,"square",.05,.06)},
 open:()=>tone(420,.05,"sine",.03),
 close:()=>tone(320,.05,"sine",.03),
 click:()=>tone(700,.035,"square",.025),
 step:()=>{noiseBurst(.035,.025);tone(95,.05,"sine",.02)},
 login:()=>{tone(392,.08,"triangle",.05);tone(523,.08,"triangle",.05,.08);tone(659,.16,"triangle",.06,.16)}
};
function sfx(kind){const f=sfxDefs[kind];if(f)f()}
// Every button on the page gets a quiet confirmation click, without having
// to wire sfx() into every single button handler individually. Touch
// control buttons (attack/talk/bag/stats) call e.preventDefault() on
// pointerdown, which suppresses the synthetic click DOM event, so they
// don't double up with their own dedicated sound effects.
document.addEventListener("click",e=>{if(e.target.closest("button"))sfx("click")});

// A very quiet, continuous two-note drone with a slow LFO on its volume so
// the game doesn't feel silent between sound effects. Starts once when the
// game starts and runs until logout; never restarted while already playing.
let ambient=null;
function startAmbient(){
 if(ambient)return;
 initAudio();
 const o1=audioContext.createOscillator(),o2=audioContext.createOscillator();
 const g=audioContext.createGain();
 o1.type="sine";o1.frequency.value=110;
 o2.type="sine";o2.frequency.value=110*1.5;
 g.gain.value=.012;
 const lfo=audioContext.createOscillator();lfo.frequency.value=.07;
 const lfoGain=audioContext.createGain();lfoGain.gain.value=.006;
 lfo.connect(lfoGain);lfoGain.connect(g.gain);
 o1.connect(g);o2.connect(g);g.connect(audioContext.destination);
 o1.start();o2.start();lfo.start();
 ambient={o1,o2,lfo};
}
function stopAmbient(){
 if(!ambient)return;
 try{ambient.o1.stop();ambient.o2.stop();ambient.lfo.stop()}catch(e){}
 ambient=null;
}

function blocked(x,y){
 const tx=Math.floor(x/TILE),ty=Math.floor(y/TILE);
 if(tx<0||ty<0||tx>=MW||ty>=MH)return true;
 if(map[ty][tx]==="#326b83")return true;
 for(const d of decorations)if(d.type==="tree"&&Math.hypot(x-d.x,y-d.y)<28)return true;
 return false;
}
const decorations=[];
function addTree(x,y){decorations.push({type:"tree",x:x*TILE+24,y:y*TILE+25})}
for(let i=0;i<170;i++){
 let z=zones[Math.floor(Math.random()*zones.length)];
 let tx=Math.floor(z.x1+Math.random()*(z.x2-z.x1+1)),ty=Math.floor(z.y1+Math.random()*(z.y2-z.y1+1));
 if(onBridge(tx,ty)||map[ty]?.[tx]==="#326b83")continue; // never block a bridge or plant a tree in the river
 addTree(tx,ty);
}

// Pick a random point inside a zone, but only accept tiles that are
// actually walkable (not water/river, not inside a tree). Some zones'
// rectangles overlap the rivers carved into the map, so without this
// check mobs could spawn on the far side of a river the player can't
// cross to reach. Falls back to the zone's center if nothing walkable
// turns up after a bunch of tries (should basically never happen).
function randomSpawn(z){
 for(let attempt=0;attempt<40;attempt++){
  const tx=z.x1+2+Math.random()*Math.max(1,z.x2-z.x1-3);
  const ty=z.y1+2+Math.random()*Math.max(1,z.y2-z.y1-3);
  if(!blocked(tx*TILE+24,ty*TILE+24))return [tx,ty];
 }
 return [(z.x1+z.x2)/2,(z.y1+z.y2)/2];
}
for(const z of zones)for(let i=0;i<8;i++){let p=randomSpawn(z);spawnMob(z.mob,p[0],p[1])}

function movePlayer(){
 let dx=0,dy=0;if(keys.w){dy--;player.direction="up"}if(keys.s){dy++;player.direction="down"}if(keys.a){dx--;player.direction="left"}if(keys.d){dx++;player.direction="right"}
 player.moving=dx||dy;if(dx&&dy){dx*=.707;dy*=.707}
 const sp=derived().speed,nx=player.x+dx*sp,ny=player.y+dy*sp;
 if(!blocked(nx,player.y))player.x=nx;if(!blocked(player.x,ny))player.y=ny;
 if(player.moving&&++player.anim>6)player.anim=0;
}
function attack(){
  if(!currentUser||!cloudLoaded){showMessage("Log in first.");return}
  if(player.attackCooldown>0)return;
  player.attackCooldown=derived().attackDelay;player.attacking=true;player.attackFrame=4;sfx("attack");

  const target=remotePlayerAtRange();
  if(target){
    let dmg=Math.max(1,Math.floor(derived().attack*(.85+Math.random()*.3)));
    const crit=Math.random()*100<derived().crit;if(crit)dmg=Math.floor(dmg*1.5);
    damageRemote(target,dmg);
    sfx(crit?"crit":"hit");
    showMessage(`PvP hit ${target.name||"player"} for ${dmg}${crit?" CRIT":""}!`);
    return;
  }

  let hit=false;
  for(const e of enemies)if(e.alive&&Math.hypot(player.x-e.x,player.y-e.y)<72){
    hit=true;
    if(Math.random()*100>derived().accuracy){showMessage("Miss!");sfx("miss");continue}
    let dmg=Math.max(1,Math.floor(derived().attack*(.85+Math.random()*.3)));
    const crit=Math.random()*100<derived().crit;if(crit)dmg=Math.floor(dmg*1.5);
    e.hp-=dmg;e.hitFlash=5;sfx(crit?"crit":"hit");floating(dmg,e.x,e.y,crit?"CRIT!":"");
    if(e.hp<=0)killMob(e);
  }
  if(!hit)showMessage(inPvpArena()?"No player or mob in range.":"No target in range.");
}
function killMob(e){
 e.alive=false;e.respawn=300+Math.floor(Math.random()*300);player.gold+=e.gold;gainExp(e.exp);sfx("coin");
 for(const q of questList)if(q.id===activeQuestId&&q.type===e.type&&!q.done){q.progress++;if(q.progress>=q.count){q.done=true;showMessage("Quest complete! Return to the quest NPC.");}else showMessage(`${e.name} defeated ${q.progress}/${q.count}`)}}
function gainExp(n){
 if(player.level>=MAX_LEVEL){player.exp=0;return}
 player.exp+=n;
 while(player.exp>=expNeeded()&&player.level<MAX_LEVEL){
   player.exp-=expNeeded();player.level++;player.statPoints+=3;sfx("level");player.hp=derived().maxHp;player.sp=derived().maxSp;showMessage(`LEVEL UP! Level ${player.level}! +3 stat points`);
 }
}
function expNeeded(){return Math.floor(100*Math.pow(player.level,1.35))}
function updateEnemies(){
 for(const e of enemies){
   if(!e.alive){if(--e.respawn<=0){const z=zones.find(q=>q.mob===e.type)||zones[0],p=randomSpawn(z);e.x=p[0]*TILE;e.y=p[1]*TILE;e.hp=e.maxHp;e.alive=true}continue}
   e.hitFlash=Math.max(0,e.hitFlash-1);const d=Math.hypot(player.x-e.x,player.y-e.y);
   if(d<380&&d>34){const a=Math.atan2(player.y-e.y,player.x-e.x);const nx=e.x+Math.cos(a)*e.speed,ny=e.y+Math.sin(a)*e.speed;if(!blocked(nx,e.y))e.x=nx;if(!blocked(e.x,ny))e.y=ny}
   if(d<38&&++e.attackTimer>45){let dmg=Math.max(1,e.atk-derived().defense);player.hp-=dmg;e.attackTimer=0;sfx("hurt");floating(dmg,player.x,player.y,"");if(player.hp<=0)defeat()}
 }
}
function defeat(){sfx("defeat");player.hp=derived().maxHp;player.sp=derived().maxSp;player.x=18*TILE;player.y=18*TILE;player.gold=Math.max(0,player.gold-Math.floor(player.gold*.05));showMessage("You were defeated and returned to Greenwood.");saveGame()}

function interact(){
 let near=npc.find(n=>Math.hypot(player.x-n.x,player.y-n.y)<75);
 if(!near){showMessage("Move closer to an NPC.");return}
 if(near.type==="shop"){openShop();return}
 if(near.type==="heal"){player.hp=derived().maxHp;player.sp=derived().maxSp;showMessage("Mira restored your HP and SP.");sfx("heal");return}
 openQuestNPC(near);
}
function openQuestNPC(n){
 const available=questList.filter(q=>!q.done&&(activeQuestId===null||q.id===activeQuestId||q.id%6===n.x%6));
 let q=activeQuestId?questList.find(q=>q.id===activeQuestId):null;
 if(q&&q.done){sfx("questComplete");player.gold+=q.gold;gainExp(q.exp);activeQuestId=null;showMessage(`Quest reward: ${q.gold} Gold + ${q.exp} EXP`);saveGame();return}
 if(!q){q=available[0]||questList.find(x=>!x.done);if(!q){showMessage("No quests available.");return}activeQuestId=q.id;sfx("questAccept");showMessage(`Accepted: ${q.name}`)}
 else showMessage(`${q.name}: ${q.progress}/${q.count} ${mobTypes[q.type].name}`);
}
function openShop(){
 document.getElementById("shopTitle").textContent="Blacksmith Shop";const box=document.getElementById("shopList");box.innerHTML="";
 const shopIds=["iron_sword","knight_blade","flame_saber","leather_armor","knight_mail","ember_plate","wood_shield","tower_shield","simple_boots","swift_boots","copper_ring","swift_ring","ruby_ring","red_potion","blue_potion"];
 shopIds.forEach(id=>{const i=item(id),d=document.createElement("div");d.className="item";d.innerHTML=`<div class="name">${i.name}</div><div class="rarity">${i.rarity}</div><div class="desc">${statsText(i.stats)}</div><div class="price">🪙 ${i.price}</div><button>Buy</button>`;d.querySelector("button").onclick=()=>buyItem(id);box.appendChild(d)});showPanel("shopPanel")}
function buyItem(id){const i=item(id);if(player.gold<i.price){sfx("deny");showMessage("Not enough gold.");return}player.gold-=i.price;sfx("buy");give(id);showMessage(`Bought ${i.name}`);renderInventory();updateUI();saveGame()}
function statsText(s){return Object.entries(s||{}).map(([k,v])=>`${k.toUpperCase()} ${v>0?"+":""}${v}`).join(" · ")}
function equipIndex(index){
 const i=inventory[index];if(!i?.slot)return;
 sfx("equip");
 const old=equipment[i.slot];equipment[i.slot]=i;inventory.splice(index,1);if(old)inventory.push(old);showMessage(`Equipped ${i.name}`);refreshPanels();fixVitals();saveGame()
}
function useIndex(index){
 const i=inventory[index];if(!i)return;
 if(i.cat==="consumable"){if(i.stats.heal){sfx("heal");player.hp=Math.min(derived().maxHp,player.hp+i.stats.heal);showMessage(`Used ${i.name}`)}else if(i.stats.sp){sfx("heal");player.sp=Math.min(derived().maxSp,player.sp+i.stats.sp);showMessage(`Used ${i.name}`)}else if(i.stats.teleport){sfx("teleport");player.x=18*TILE;player.y=18*TILE;showMessage("Returned to Greenwood.")}inventory.splice(index,1);refreshPanels();fixVitals();saveGame()}
}
function unequip(slot){if(!equipment[slot])return;sfx("unequip");inventory.push(equipment[slot]);equipment[slot]=null;fixVitals();refreshPanels();saveGame()}
function fixVitals(){const d=derived();player.hp=Math.min(player.hp,d.maxHp);player.sp=Math.min(player.sp,d.maxSp)}
function addStat(stat){if(player.statPoints<=0||player.stats[stat]>=99)return;player.stats[stat]++;player.statPoints--;fixVitals();refreshPanels();saveGame()}
function statsSpent(){return Object.values(player.stats).reduce((a,v)=>a+v,0)-STAT_BASE*Object.keys(player.stats).length}
const STAT_BASE=5;
function resetStats(){
 const spent=statsSpent();
 if(spent<=0){openDialog("Reset Stats","You haven't put any points into your stats yet — everything's still at base 5, so there's nothing to refund. Level up and spend points with the + buttons first.",[{text:"OK",fn:closePanels}]);return}
 openDialog("Reset Stats",`Reset all stats back to ${STAT_BASE} and refund ${spent} point${spent===1?"":"s"}?`,[
  {text:"Reset",fn:()=>{
   for(const s in player.stats)player.stats[s]=STAT_BASE;
   player.statPoints+=spent;
   sfx("questAccept");
   closePanels();
   showMessage(`Stats reset! ${spent} points refunded.`);
   fixVitals();renderCharacter();showPanel("characterPanel");saveGame();
  }},
  {text:"Cancel",fn:()=>{closePanels();showPanel("characterPanel");renderCharacter();}}
 ]);
}
document.getElementById("resetStatsBtn").onclick=resetStats;
function renderInventory(cat="all"){
 const box=document.getElementById("inventoryList");box.innerHTML="";
 inventory.forEach((i,index)=>{if(cat!=="all"&&i.cat!==cat)return;const d=document.createElement("div");d.className="item";d.innerHTML=`<div class="name">${i.name}</div><div class="rarity">${i.rarity||"Common"}</div><div class="desc">${statsText(i.stats)}</div>${i.slot?`<button>Equip</button>`:i.cat==="consumable"?`<button>Use</button>`:""}`;const b=d.querySelector("button");if(b)b.onclick=()=>i.slot?equipIndex(index):useIndex(index);box.appendChild(d)})
}
function renderCharacter(){
 const el=document.getElementById("equipmentList");el.innerHTML="";
 Object.keys(equipment).forEach(slot=>{const i=equipment[slot],d=document.createElement("div");d.className="eq-slot";d.innerHTML=`<span>${slot.toUpperCase()}: <span class="eq-name">${i?i.name:"Empty"}</span></span>${i?"<button>Unequip</button>":""}`;if(i)d.querySelector("button").onclick=()=>unequip(slot);el.appendChild(d)});
 const sl=document.getElementById("statsList");sl.innerHTML="";
 const desc={str:"Attack",agi:"Speed",vit:"HP / Defense",dex:"Accuracy",int:"SP / Magic",luk:"Critical"};
 for(const s of Object.keys(player.stats)){const d=document.createElement("div");d.className="stat-row";d.innerHTML=`<span><b class="stat-name">${s.toUpperCase()}</b> <span class="stat-desc">${desc[s]}</span></span><span>${player.stats[s]} <button ${player.statPoints<=0?"disabled":""}>+</button></span>`;d.querySelector("button").onclick=()=>addStat(s);sl.appendChild(d)}
 document.getElementById("statPointsText").textContent=`(${player.statPoints} points)`;
 const resetBtn=document.getElementById("resetStatsBtn"),spent=statsSpent();
 resetBtn.disabled=spent<=0;
 resetBtn.title=spent<=0?"No points spent yet":`Refund ${spent} spent point${spent===1?"":"s"}`;
 const d=derived();document.getElementById("derivedStats").innerHTML=["Attack","Defense","Move Speed","Attack Delay","Critical %","Accuracy %","Magic Attack","Max HP","Max SP"].map((n,i)=>`<div class="derived-row"><span>${n}</span><b>${[d.attack,d.defense,d.speed.toFixed(2),d.attackDelay,d.crit.toFixed(1),d.accuracy.toFixed(1),d.magic,d.maxHp,d.maxSp][i]}</b></div>`).join("");
}
function showPanel(id){sfx("open");document.getElementById("panelBackdrop").style.display="block";document.getElementById(id).style.display="block"}
function closePanels(){sfx("close");document.querySelectorAll(".panel").forEach(p=>p.style.display="none");document.getElementById("panelBackdrop").style.display="none"}
function togglePanel(id){if(document.getElementById(id).style.display==="block")closePanels();else{if(id==="inventoryPanel")renderInventory();if(id==="characterPanel")renderCharacter();showPanel(id)}}
function refreshPanels(){if(document.getElementById("inventoryPanel").style.display==="block")renderInventory();if(document.getElementById("characterPanel").style.display==="block")renderCharacter()}
document.querySelectorAll(".tabs button").forEach(b=>b.onclick=()=>renderInventory(b.dataset.cat));
function openDialog(title,text,actions=[]){document.getElementById("dialogTitle").textContent=title;document.getElementById("dialogText").textContent=text;const a=document.getElementById("dialogActions");a.innerHTML="";actions.forEach(x=>{const b=document.createElement("button");b.className="action";b.textContent=x.text;b.onclick=x.fn;a.appendChild(b)});showPanel("dialogPanel")}

function questUI(){
 const q=activeQuestId&&questList.find(x=>x.id===activeQuestId);document.getElementById("questName").textContent=q?q.name:"No Active Quest";document.getElementById("questDescription").textContent=q?`Defeat ${q.count} ${mobTypes[q.type].name}. Reward: ${q.exp} EXP + ${q.gold} Gold.`:"Talk to a quest NPC.";document.getElementById("questProgress").textContent=q?`${q.progress} / ${q.count}`:"0 / 0";
}
function updateUI(){
 const d=derived();document.getElementById("hpBar").style.width=`${player.hp/d.maxHp*100}%`;document.getElementById("spBar").style.width=`${player.sp/d.maxSp*100}%`;document.getElementById("expBar").style.width=`${player.level>=MAX_LEVEL?100:player.exp/expNeeded()*100}%`;document.getElementById("levelText").textContent=player.level;document.getElementById("goldText").textContent=player.gold;document.getElementById("zoneLabel").textContent=zoneAt(player.x,player.y).name;document.getElementById("pvpStatus").textContent=inPvpArena()?"⚔ PVP ENABLED":"🛡 PVP SAFE";document.getElementById("pvpStatus").className=inPvpArena()?"pvp-on":"pvp-off";document.querySelector(".player-name").textContent=playerName;questUI()
}

function drawMap(){
 const sx=Math.floor(camera.x/TILE)-1,sy=Math.floor(camera.y/TILE)-1,ex=sx+Math.ceil(canvas.width/TILE)+2,ey=sy+Math.ceil(canvas.height/TILE)+2;
 for(let y=sy;y<ey;y++)for(let x=sx;x<ex;x++){if(x<0||y<0||x>=MW||y>=MH)continue;ctx.fillStyle=map[y][x];ctx.fillRect(x*TILE-camera.x,y*TILE-camera.y,TILE,TILE);if(map[y][x]!=="#326b83"&&Math.random()<0.02){ctx.fillStyle="rgba(255,255,255,.06)";ctx.fillRect(x*TILE+10-camera.x,y*TILE+10-camera.y,3,8)}}
 for(let x=0;x<MW;x++)for(let y=0;y<MH;y++){if((x+y)%13===0&&map[y][x]!=="#326b83"){ctx.strokeStyle="rgba(255,255,255,.08)";ctx.strokeRect(x*TILE-camera.x,y*TILE-camera.y,TILE,TILE)}}
}
function drawArena(){
  const x1=pvpArena.x1*TILE-camera.x,y1=pvpArena.y1*TILE-camera.y,w=(pvpArena.x2-pvpArena.x1+1)*TILE,h=(pvpArena.y2-pvpArena.y1+1)*TILE;
  ctx.strokeStyle="#ff5577";ctx.lineWidth=5;ctx.strokeRect(x1,y1,w,h);
  ctx.fillStyle="rgba(255,70,110,.12)";ctx.fillRect(x1,y1,w,h);
  ctx.fillStyle="#ff9aaf";ctx.font="bold 24px Arial";ctx.textAlign="center";ctx.fillText("⚔ PVP ARENA ⚔",x1+w/2,y1+32);
}
function drawDecorations(){for(const d of decorations){const x=d.x-camera.x,y=d.y-camera.y;ctx.fillStyle="rgba(0,0,0,.25)";ctx.beginPath();ctx.ellipse(x,y+25,18,6,0,0,Math.PI*2);ctx.fill();ctx.fillStyle="#65432d";ctx.fillRect(x-5,y-2,10,27);ctx.fillStyle="#255f32";ctx.beginPath();ctx.arc(x,y-10,25,0,Math.PI*2);ctx.fill();ctx.fillStyle="#3d8643";ctx.beginPath();ctx.arc(x-12,y-15,15,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x+13,y-18,14,0,Math.PI*2);ctx.fill()}}
function drawNPCs(){for(const n of npc){const x=n.x-camera.x,y=n.y-camera.y;ctx.fillStyle="rgba(0,0,0,.3)";ctx.beginPath();ctx.ellipse(x,y+18,15,6,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=n.type==="shop"?"#a36b35":n.type==="heal"?"#4f9f91":"#70458f";ctx.fillRect(x-12,y-5,24,25);ctx.fillStyle="#e5b08b";ctx.fillRect(x-10,y-24,20,18);ctx.fillStyle="#d5d5d5";ctx.fillRect(x-11,y-27,22,8);ctx.fillStyle="#ffd447";ctx.font="bold 14px Arial";ctx.textAlign="center";ctx.fillText(n.type==="shop"?"$":n.type==="heal"?"+":"!",x,y-33);}}
function drawPlayer(){const x=Math.round(player.x-camera.x),y=Math.round(player.y-camera.y);ctx.fillStyle="rgba(0,0,0,.35)";ctx.beginPath();ctx.ellipse(x,y+18,15,6,0,0,Math.PI*2);ctx.fill();let leg=player.moving?(player.anim<3?-3:3):0;ctx.fillStyle="#252a38";ctx.fillRect(x-9+leg,y+5,7,14);ctx.fillRect(x+2-leg,y+5,7,14);ctx.fillStyle="#513a2b";ctx.fillRect(x-10+leg,y+17,9,5);ctx.fillRect(x+1-leg,y+17,9,5);ctx.fillStyle="#376da8";ctx.fillRect(x-12,y-9,24,19);ctx.fillStyle="#528bc7";ctx.fillRect(x-9,y-7,6,12);ctx.fillStyle="#dca781";ctx.fillRect(x-16,y-5,6,15);ctx.fillRect(x+10,y-5,6,15);ctx.fillStyle="#e5ae87";ctx.fillRect(x-10,y-25,20,18);ctx.fillStyle="#33251f";ctx.fillRect(x-11,y-27,22,8);if(player.direction==="down"){ctx.fillStyle="#222";ctx.fillRect(x-6,y-17,3,3);ctx.fillRect(x+3,y-17,3,3)}if(player.attacking){ctx.save();ctx.translate(x,y);let a={right:-.4,left:Math.PI+.4,up:-Math.PI/2,down:Math.PI/2}[player.direction];ctx.rotate(a);ctx.fillStyle="#754b29";ctx.fillRect(13,-3,8,6);ctx.fillStyle="#e8edf2";ctx.fillRect(20,-3,32,6);ctx.fillStyle="#fff";ctx.fillRect(23,-2,25,2);ctx.fillStyle="#c99b3b";ctx.fillRect(17,-8,5,16);ctx.restore()}}
function drawEnemies(){for(const e of enemies)if(e.alive){const x=e.x-camera.x,y=e.y-camera.y,t=mobTypes[e.type];ctx.fillStyle="rgba(0,0,0,.3)";ctx.beginPath();ctx.ellipse(x,y+17,17,6,0,0,Math.PI*2);ctx.fill();ctx.fillStyle=e.hitFlash?"#fff":t.color;ctx.beginPath();ctx.arc(x,y,18,Math.PI,0);ctx.lineTo(x+18,y+11);ctx.lineTo(x-18,y+11);ctx.closePath();ctx.fill();ctx.fillStyle="#fff";ctx.fillRect(x-8,y-5,5,7);ctx.fillRect(x+3,y-5,5,7);ctx.fillStyle="#222";ctx.fillRect(x-6,y-3,2,4);ctx.fillRect(x+5,y-3,2,4);ctx.fillStyle="#222";ctx.fillRect(x-21,y-30,42,5);ctx.fillStyle="#e33";ctx.fillRect(x-21,y-30,42*Math.max(0,e.hp/e.maxHp),5);ctx.fillStyle="#ffd85c";ctx.font="9px Arial";ctx.textAlign="center";ctx.fillText("Lv."+e.level,x,y-34)}}
const floats=[];function floating(text,x,y,sub){floats.push({text:String(text),sub,x,y,t:45})}
function drawFloats(){for(const f of floats){f.y-=.5;f.t--;ctx.fillStyle=f.sub==="CRIT!"?"#ffd84d":"#fff";ctx.font="bold 14px Arial";ctx.textAlign="center";ctx.fillText(f.sub||"-"+f.text,f.x-camera.x,f.y-camera.y)}}
function updateFloats(){for(let i=floats.length-1;i>=0;i--)if(--floats[i].t<=0)floats.splice(i,1)}

function updateCamera(){camera.x=Math.max(0,Math.min(MW*TILE-canvas.width,player.x-canvas.width/2));camera.y=Math.max(0,Math.min(MH*TILE-canvas.height,player.y-canvas.height/2))}
function drawMinimap(){
 mctx.clearRect(0,0,220,150);const sx=220/MW,sy=150/MH;
 for(let y=0;y<MH;y++)for(let x=0;x<MW;x++){mctx.fillStyle=map[y][x]==="#326b83"?"#2f6d87":map[y][x];mctx.fillRect(x*sx,y*sy,Math.ceil(sx),Math.ceil(sy))}
 zones.forEach(z=>{mctx.fillStyle="#fff";mctx.font="8px Arial";mctx.fillText(z.name.split(" ")[0],z.x1*sx+2,z.y1*sy+9)});
 for(const n of npc){mctx.fillStyle=n.type==="shop"?"#ffd84d":"#fff";mctx.fillRect(n.x/TILE*sx-1,n.y/TILE*sy-1,3,3)}
 for(const e of enemies)if(e.alive){mctx.fillStyle="#e45a5a";mctx.fillRect(e.x/TILE*sx-1,e.y/TILE*sy-1,2,2)}
 for(const [uid,p] of Object.entries(remotePlayers)){if(uid===currentUser?.uid||!p||typeof p.x!=="number"||Date.now()-(p.lastSeen||0)>30000)continue;mctx.fillStyle="#ff4fd8";mctx.fillRect(p.x/TILE*sx-2,p.y/TILE*sy-2,5,5)}
 mctx.fillStyle="#48e0ff";mctx.fillRect(player.x/TILE*sx-2,player.y/TILE*sy-2,5,5)
}
let messageTimer;function showMessage(t){const m=document.getElementById("message");m.textContent=t;m.style.opacity=1;clearTimeout(messageTimer);messageTimer=setTimeout(()=>m.style.opacity=0,2200)}

async function saveGame(){
  const data={player:{x:player.x,y:player.y,level:player.level,exp:player.exp,gold:player.gold,hp:player.hp,sp:player.sp,statPoints:player.statPoints,stats:player.stats},equipment,inventory,activeQuestId,quests:questList.map(q=>({id:q.id,progress:q.progress,done:q.done})),profile:{name:playerName}};
  localStorage.setItem("JAY_RPG_SAVE_V2",JSON.stringify(data));
  if(currentUser){
    try{await set(ref(db,`characters/${currentUser.uid}`),data)}catch(e){console.warn("Cloud save failed",e)}
  }
}
function loadGame(){
  try{
    const d=JSON.parse(localStorage.getItem("JAY_RPG_SAVE_V2"));if(!d)return;
    Object.assign(player,d.player);Object.assign(equipment,d.equipment||{});
    inventory.length=0;(d.inventory||[]).forEach(i=>inventory.push(i));
    activeQuestId=d.activeQuestId??null;
    (d.quests||[]).forEach(q=>{const x=questList.find(a=>a.id===q.id);if(x){x.progress=q.progress;x.done=q.done}});
    if(d.profile?.name)playerName=d.profile.name;
    fixVitals();
  }catch(e){console.warn("Save load failed",e)}
}
loadGame();

function toggleMap(){showMessage("The minimap is already visible in the bottom-right.");}
function checkRemotePvPState(){
  if(player.hp<=0){defeat();return}
  if(!inPvpArena()&&document.getElementById("pvpStatus"))document.getElementById("pvpStatus").textContent="🛡 PVP SAFE";
}
function gameLoop(){
 if(!gameStarted)return;
 movePlayer();updateEnemies();if(player.attackCooldown>0)player.attackCooldown--;if(player.attacking&&--player.attackFrame<=0)player.attacking=false;updateCamera();updateFloats();ctx.clearRect(0,0,canvas.width,canvas.height);drawMap();drawArena();drawDecorations();drawNPCs();drawEnemies();drawRemotePlayers();drawPlayer();drawFloats();drawMinimap();updateUI();requestAnimationFrame(gameLoop)
}
function startGame(){
 if(gameStarted)return;
 gameStarted=true;
 sfx("login");
 startAmbient();
 authScreen.style.display="none";
 logoutBtn.style.display="block";
 requestAnimationFrame(gameLoop);
}
function stopGame(){
 gameStarted=false;
 stopAmbient();
 if(onlineSyncTimer){clearInterval(onlineSyncTimer);onlineSyncTimer=null;}
 if(playersUnsub){playersUnsub();playersUnsub=null;}
 playersListenerStarted=false;
 if(connUnsub){connUnsub();connUnsub=null;}
 if(currentUser)remove(ref(db,`players/${currentUser.uid}`)).catch(()=>{});
 remotePlayers={};
 authScreen.style.display="flex";
 logoutBtn.style.display="none";
 document.getElementById("onlineStatus").textContent="OFFLINE";
 setAuthBusy(false);
 authMsg("Log in or create an account.");
}

document.getElementById("authForm").addEventListener("submit",e=>{e.preventDefault();loginAccount()});
document.getElementById("registerBtn").addEventListener("click",()=>registerAccount());
document.getElementById("logoutBtn").addEventListener("click",()=>logoutRPG());
document.querySelectorAll("[data-close]").forEach(b=>b.addEventListener("click",closePanels));
document.getElementById("panelBackdrop").addEventListener("click",closePanels);

onAuthStateChanged(auth,user=>{
  currentUser=user;
  if(user){
    // Auth success immediately opens the RPG. Cloud loading is secondary.
    if(!gameStarted)startGameForUser(user);
    loadCloudCharacter(user).catch(e=>console.warn("Cloud character load failed:",e));
  }else{
    cloudLoaded=false;
    stopGame();
  }
});

setInterval(()=>{if(gameStarted)saveGame()},10000);
/* ================= MOBILE TOUCH CONTROLS =================
   Shows a joystick + action buttons on phones/tablets only.
   The joystick presses the same W/A/S/D keys the game already uses. */
(function setupTouchControls(){
  const isTouch=matchMedia("(pointer:coarse)").matches||("ontouchstart" in window&&!matchMedia("(hover:hover)").matches)||navigator.maxTouchPoints>0&&innerWidth<=900||innerWidth<=700||/[?&]touch\b/.test(location.search);
  if(!isTouch)return;
  document.body.classList.add("touch");

  const css=document.createElement("style");
  css.textContent=`
    html,body{overscroll-behavior:none}
    body.touch #game{height:100dvh}
    body.touch #gameCanvas{touch-action:none}
    body.touch #controls{display:none}
    body.touch #minimap{transform:scale(.55);transform-origin:bottom right;right:calc(10px + env(safe-area-inset-right,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px))}
    body.touch #message{bottom:calc(130px + env(safe-area-inset-bottom,0px));white-space:normal;text-align:center;max-width:80vw}
    #touchControls{position:absolute;inset:0;z-index:15;pointer-events:none;touch-action:none;-webkit-touch-callout:none;-webkit-user-select:none;user-select:none}
    #joy{position:absolute;left:calc(22px + env(safe-area-inset-left,0px));bottom:calc(26px + env(safe-area-inset-bottom,0px));width:132px;height:132px;border-radius:50%;background:rgba(255,255,255,.10);border:2px solid rgba(233,195,91,.55);pointer-events:auto;touch-action:none}
    #joyKnob{position:absolute;left:50%;top:50%;width:58px;height:58px;margin:-29px 0 0 -29px;border-radius:50%;background:rgba(233,195,91,.55);border:2px solid rgba(255,235,170,.8);pointer-events:none}
    #tbtns{position:absolute;right:calc(14px + env(safe-area-inset-right,0px));bottom:calc(122px + env(safe-area-inset-bottom,0px));width:160px;height:160px;pointer-events:none}
    #tbtns button{position:absolute;border-radius:50%;border:2px solid #b89b52;background:rgba(20,25,36,.82);color:#fff;font-size:24px;pointer-events:auto;touch-action:none;-webkit-tap-highlight-color:transparent;font-family:inherit;padding:0;line-height:1}
    #tbtns button:active{background:rgba(233,195,91,.55)}
    #tbtns button small{display:block;font-size:9px;margin-top:2px;color:#e9c35b}
    #tAtk{right:0;bottom:0;width:82px;height:82px;font-size:34px!important;background:rgba(150,35,50,.85)!important}
    #tTalk{right:92px;bottom:0;width:58px;height:58px}
    #tBag{right:72px;bottom:70px;width:58px;height:58px}
    #tChar{right:2px;bottom:94px;width:58px;height:58px}
    @media(max-height:480px){#tbtns{transform:scale(.8);transform-origin:bottom right;bottom:calc(100px + env(safe-area-inset-bottom,0px))}#joy{width:112px;height:112px}}
  `;
  document.head.appendChild(css);

  const wrap=document.createElement("div");
  wrap.id="touchControls";
  wrap.innerHTML=`
    <div id="joy"><div id="joyKnob"></div></div>
    <div id="tbtns">
      <button id="tAtk" type="button">⚔</button>
      <button id="tTalk" type="button">💬<small>TALK</small></button>
      <button id="tBag" type="button">🎒<small>BAG</small></button>
      <button id="tChar" type="button">👤<small>STATS</small></button>
    </div>`;
  document.getElementById("game").appendChild(wrap);
  wrap.addEventListener("contextmenu",e=>e.preventDefault());

  const canAct=()=>gameStarted&&authScreen.style.display==="none";

  // ---- Joystick -> WASD keys ----
  const joy=document.getElementById("joy"),knob=document.getElementById("joyKnob");
  let joyId=null;
  function setKeys(dx,dy){const t=.35;keys.a=dx<-t;keys.d=dx>t;keys.w=dy<-t;keys.s=dy>t}
  function joyMove(e){
    const r=joy.getBoundingClientRect(),max=r.width/2;
    let dx=e.clientX-(r.left+max),dy=e.clientY-(r.top+max);
    const d=Math.hypot(dx,dy);if(d>max){dx=dx/d*max;dy=dy/d*max}
    knob.style.transform=`translate(${dx}px,${dy}px)`;
    setKeys(dx/max,dy/max);
  }
  function joyEnd(e){if(e.pointerId!==joyId)return;joyId=null;knob.style.transform="";setKeys(0,0)}
  joy.addEventListener("pointerdown",e=>{e.preventDefault();joyId=e.pointerId;try{joy.setPointerCapture(e.pointerId)}catch(_){}joyMove(e)});
  joy.addEventListener("pointermove",e=>{if(e.pointerId===joyId)joyMove(e)});
  joy.addEventListener("pointerup",joyEnd);
  joy.addEventListener("pointercancel",joyEnd);

  // ---- Buttons ----
  function press(id,fn){
    document.getElementById(id).addEventListener("pointerdown",e=>{e.preventDefault();if(!canAct())return;initAudio();fn()});
  }
  // Attack: tap, or hold to keep attacking
  const atk=document.getElementById("tAtk");let atkTimer=null;
  const stopAtk=()=>{clearInterval(atkTimer);atkTimer=null};
  atk.addEventListener("pointerdown",e=>{e.preventDefault();if(!canAct())return;initAudio();attack();stopAtk();atkTimer=setInterval(()=>{if(canAct())attack()},120)});
  ["pointerup","pointercancel","pointerleave"].forEach(ev=>atk.addEventListener(ev,stopAtk));
  press("tTalk",interact);
  press("tBag",()=>togglePanel("inventoryPanel"));
  press("tChar",()=>togglePanel("characterPanel"));

  // Safety: never leave the character walking if the window loses focus
  addEventListener("blur",()=>{setKeys(0,0);joyId=null;knob.style.transform="";stopAtk()});
})();
