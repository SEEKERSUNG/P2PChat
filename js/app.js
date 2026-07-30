"use strict";
/* ===================== 数据层 ===================== */
const STORE_KEY = "ipvchat_data";
/* STUN 辅助始终启用：使用国内公共 STUN 获取 srflx 反射地址，绕过 Chrome mDNS 混淆
   （mDNS 把 host 候选改写为 *.local，跨子网/公网无法解析）。srflx 不受 mDNS 影响。
   国内 STUN 仅支持 IPv4；末尾补充 Google STUN（支持 IPv6 AAAA）以在 mDNS 隐藏公网 IPv6 时
   提供 IPv6 srflx 兜底。Google 国内可能不可达，不可达时仅退回 IPv4，不影响连接。
   仅在建连阶段联系 STUN 获取反射地址，消息仍端到端加密、不经过 STUN。局域网亦可启用（无害）。 */
const DEFAULT_STUN_SERVERS = [
  {urls:'stun:stun.miwifi.com:3478'},        // 小米
  {urls:'stun:stun.qq.com:3478'},            // 腾讯
  {urls:'stun:stun.chat.bilibili.com:3478'}, // B站
  {urls:'stun:stun.cloudflare.com:3478'},    // Cloudflare（支持 IPv6 反射；国内可达）
  {urls:'stun:stun.l.google.com:3478'}       // Google（补充候补，支持 IPv6 反射；国内可能不可达，不可达时退回 IPv4）
];

let store = loadStore();
let currentId = null;          // 当前选中联系人 id
let pendingPC = null;          // 握手中的 PeerConnection
let pendingRole = null;        // 'offer' | 'answer'
let pendingChannel = null;
let pendingPeerIps = null;     // 解析对端连接码时暂存其真实 IP（供 finalizeChannel 写入 contact.peerIps）
let connections = new Map();   // contactId -> {chat, file, pc, outSeq, inSeq, pending} (双通道连接)
let channelMap = new Map();    // channel -> {pc, contactId|null, isChat}
let revivable = new Map();     // contactId -> pc（断开后保留的存活通道，用于尝试免交换码恢复）
let peerBye = new Set();       // 收到对端 bye 主动断开的联系人，不自动恢复
let autoReviveTimers = new Map(); // contactId -> timeoutId

function defaultStore(){
  return {
    version:4,
    identity:{ id: randId(), name:"用户"+Math.floor(Math.random()*9000+1000) },
    contacts:[],
    messages:{},
    settings:{},
    unread:{}
  };
}
function loadStore(){
  try{
    const raw = localStorage.getItem(STORE_KEY);
    if(!raw) return defaultStore();
    const d = JSON.parse(raw);
    if(!d.identity) d.identity = defaultStore().identity;
    if(!d.contacts) d.contacts = [];
    if(!d.messages) d.messages = {};
    if(!d.settings) d.settings = {};
    if(!d.unread) d.unread = {};
    // 迁移：分离「对端用户名 peerName」与「自定义备注 name」
    d.contacts.forEach(c=>{
      if(c.nameSet===undefined) c.nameSet=false;
      if(c.peerName===undefined) c.peerName = c.nameSet ? '' : (c.name||'');
    });
    d.version = 4; // v4 起仅直连，忽略历史 STUN 配置
    return d;
  }catch(e){ console.warn("load fail",e); return defaultStore(); }
}
function saveStore(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(store)); }catch(e){ console.warn("save fail",e); } }

function randId(){ return "p"+Math.random().toString(36).slice(2,10)+Date.now().toString(36).slice(-4); }
function nowTs(){ return Date.now(); }
function fmtTime(ts){
  const d = new Date(ts), p=n=>String(n).padStart(2,'0');
  const today=new Date(); const same = d.toDateString()===today.toDateString();
  return same? `${p(d.getHours())}:${p(d.getMinutes())}` : `${d.getMonth()+1}/${d.getDate()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ===================== 联系人 ===================== */
function getContact(id){ return store.contacts.find(c=>c.id===id); }
/* 显示名：有备注则「备注（用户名）」，无备注则显示用户名 */
function contactDisplayText(c){
  const peer = c.peerName || c.name || '未知';
  if(c.nameSet && c.name) return `${c.name}（${peer}）`;
  return peer;
}
function contactDisplayHtml(c){
  const peer = c.peerName || c.name || '未知';
  if(c.nameSet && c.name) return `${escapeHtml(c.name)}<span style="color:var(--mut);font-weight:400">（${escapeHtml(peer)}）</span>`;
  return escapeHtml(peer);
}
function ensureContact(peerId, name){
  let c = getContact(peerId);
  if(!c){ c={id:peerId,name:"",ip:"",lastSeen:0,note:"",nameSet:false,peerName:name||("用户"+Math.floor(Math.random()*9000+1000))}; store.contacts.push(c); }
  if(name) c.peerName = name; // 每次连接同步对端账号用户名
  return c;
}
function isMobile(){ return window.matchMedia && window.matchMedia('(max-width:680px)').matches; }
function selectContact(id){
  currentId=id;
  if(store.unread[id]){ store.unread[id]=0; saveStore(); }
  // 记录进入聊天的时间，用于渲染新消息分界线
  const c = getContact(id);
  if(c){ c.lastReadTs = nowTs(); saveStore(); }
  updateMobileView(); renderContacts(); renderChat();
  if(id && connections.has(id)) sendReadReceipt(id); // 选中已连接联系人时发已读回执
  if(isMobile() && id){ try{ history.pushState({p2pchat:'chat'},''); }catch(e){} }
}
function goBack(){ currentId=null; updateMobileView(); renderContacts(); renderChat(); }
function backBtn(){ if(isMobile() && currentId){ try{ history.back(); }catch(e){ goBack(); } } else { goBack(); } }
function updateMobileView(){
  const app=document.getElementById('app');
  if(currentId) app.classList.add('show-chat'); else app.classList.remove('show-chat');
}

/* ===================== WebRTC ===================== */
function newPC(){
  // STUN 辅助始终启用：填入国内公共 STUN，收集 srflx 候选绕过 mDNS 混淆
  const pc = new RTCPeerConnection({ iceServers: DEFAULT_STUN_SERVERS });
  // 默认处理对端在存活通道上新开的 DataChannel（用于免交换码恢复）
  pc.ondatachannel = e=>{ if(!channelMap.has(e.channel)) bindChannel(e.channel, pc, null, null, e.channel.label==='chat'); };
  return pc;
}

/* 探测本机 IP（IPv4/IPv6）：用 WebRTC ICE host 候选收集（仅直连，无 STUN，避免 srflx 污染本机地址） */
function isRealIp(a){ return !!a && !a.endsWith('.local') && a!=='0.0.0.0' && a!=='::'; }
/* 核心收集：创建临时 PC（启用 STUN）收集 host / srflx 候选，返回 {host4,host6,mdns,srflx}（均为 Set）。
   srflx 为 STUN 反射的公网地址，不受 mDNS 影响——本机真实 IP 被隐藏时用它展示与连接。 */
async function collectMyIps(){
  const ips={host4:new Set(),host6:new Set(),mdns:new Set(),srflx:new Set()};
  let pc;
  try{
    pc=new RTCPeerConnection({iceServers: DEFAULT_STUN_SERVERS});
    pc.createDataChannel('ip');
    pc.onicecandidate=e=>{
      if(!e.candidate||!e.candidate.candidate) return;
      const parts=e.candidate.candidate.split(' ');
      const addr=parts[4], typ=parts[7];
      if(!addr||!typ) return;
      const bucket=(a)=> a.includes(':')?ips.host6:ips.host4;
      if(addr.endsWith('.local')){ ips.mdns.add(addr); }
      else if(typ==='host'){ bucket(addr).add(addr); }
      else if(typ==='srflx'){ ips.srflx.add(addr); } // STUN 反射地址（公网）
    };
    const offer=await pc.createOffer();
    await pc.setLocalDescription(offer);
    await waitIceComplete(pc);
  }catch(e){ /* ignore */ }
  finally{ try{pc&&pc.close();}catch(e){} }
  return ips;
}
async function refreshMyIp(){
  const box=document.getElementById('myIpBox');
  if(box) box.innerHTML='<span class="mi-empty">检测中…</span>';
  const ips=await collectMyIps();
  renderMyIp(ips);
}
function renderMyIp(ips){
  const box=document.getElementById('myIpBox'); if(!box) return;
  const lines=[];
  const push=(tag,set,note)=>{
    set.forEach(a=>{
      const ll = a.toLowerCase().startsWith('fe80')?' (链路本地)':'';
      lines.push(`<div class="mi-line"><span class="mi-tag">${tag}</span>${escapeHtml(a)}${ll}${note?` <span style="color:var(--mut);font-size:10px">${note}</span>`:''}</div>`);
    });
  };
  push('IPv4',ips.host4);
  push('IPv6',ips.host6);
  push('STUN',ips.srflx, '反射公网');
  const hasHost = ips.host4.size + ips.host6.size > 0;
  let html=lines.join('');
  if(!html){
    if(ips.mdns.size){
      html='<div class="mi-note">仅检测到 mDNS（*.local），且 STUN 未返回反射地址。请检查网络能否访问 STUN 服务器。</div>';
    }else{
      html='<div class="mi-empty">未检测到 IP 地址</div>';
    }
  }else if(!hasHost && ips.srflx.size){
    // 本机真实 IP 被 mDNS 全部隐藏，显示的是 STUN 反射的公网地址
    html='<div class="mi-note">⚠ 本机真实 IP 被 mDNS 隐藏，以下为 STUN 反射获取的公网地址（已用于保障连接）：</div>'+html;
  }else if(ips.mdns.size){
    html+='<div class="mi-note">部分本地 IP 被隐藏为 mDNS（*.local）；已启用 STUN 辅助保障连接。</div>';
  }
  box.innerHTML=html;
}

function waitIceComplete(pc){
  return new Promise(res=>{
    if(pc.iceGatheringState==='complete') return res();
    let done=false;
    const finish=()=>{ if(!done){ done=true; pc.removeEventListener('icegatheringstatechange',check); res(); } };
    const check=()=>{ if(pc.iceGatheringState==='complete') finish(); };
    pc.addEventListener('icegatheringstatechange',check);
    // 兜底：gathering 通常很快完成，5s 后用已收集的候选继续，防止异常卡死
    setTimeout(finish, 5000);
  });
}

function encodeSignal(obj){ return btoa(unescape(encodeURIComponent(JSON.stringify(obj)))); }
function decodeSignal(s){ return JSON.parse(decodeURIComponent(escape(atob(s.trim())))); }

/* 检查 localDescription 中是否含有「真实 IP 的 host 候选」（非 mDNS） */
function hasRealHostCandidate(pc){
  const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
  return sdp.split('\n').some(l=>{
    if(!l.startsWith('a=candidate=') || !l.includes(' typ host')) return false;
    const addr = l.split(' ')[4];
    return addr && !addr.endsWith('.local');
  });
}
/* 从已收集完成的 localDescription 中提取本机真实 IP（host + srflx，排除 .local）。
   复用握手 PC 已收集的候选，避免再开临时 PC 做 STUN 收集（省一次往返）。 */
function extractIpsFromPc(pc){
  const sdp = (pc.localDescription && pc.localDescription.sdp) || '';
  const ips = new Set();
  sdp.split('\n').forEach(l=>{
    if(!l.startsWith('a=candidate=')) return;
    const parts = l.split(' ');
    const addr = parts[4], typ = parts[7];
    if(!addr || !typ) return;
    if((typ==='host' || typ==='srflx') && isRealIp(addr)) ips.add(addr);
  });
  return [...ips];
}

/* 连接诊断：STUN 始终启用，根据本机是否有真实 host 候选 / 对端 IP 给出场景化提示 */
function connectDiagnose(pc){
  const hasReal = hasRealHostCandidate(pc);
  const c = currentId && getContact(currentId);
  const peerIps = (c && c.peerIps) || pendingPeerIps || [];
  const peerStr = peerIps.length ? `对端地址：${peerIps.join(' / ')}。` : '';
  if(!hasReal){
    return `⚠ 连接未建立。本机真实 IP 被 mDNS 隐藏（*.local），已通过 STUN 获取反射地址。若仍失败请确认：①系统防火墙放行入站 UDP ②网络可访问 STUN 服务器 ③双方在同一局域网或均具公网 IP。${peerStr}`;
  }
  return `⚠ 连接未建立。本机已暴露真实 IP，请确认对端：①防火墙放行入站 UDP ②未因 mDNS 隐藏真实 IP ③与你在同一局域网或具公网 IP。${peerStr}`;
}

/* 连接建立看门狗：提交应答码后若 20s 内未建立连接，给出诊断提示 */
let connectWatchdog=null;
function startConnectWatchdog(pc, label){
  clearConnectWatchdog();
  connectWatchdog = setTimeout(()=>{
    const established = [...channelMap.values()].some(i=>i.pc===pc && i.contactId);
    if(!established){
      toast(connectDiagnose(pc), 10000);
    }
  }, 20000);
}
function clearConnectWatchdog(){ if(connectWatchdog){ clearTimeout(connectWatchdog); connectWatchdog=null; } }

/* 快速重连：先尝试基于存活通道免交换码恢复，失败再回退到交换连接码 */
async function quickReconnect(){
  if(!currentId) return;
  const c=getContact(currentId); if(!c) return;
  if(connections.has(currentId)){ toast("已处于连接状态"); return; }
  // 1) 先尝试恢复
  if(revivable.has(currentId)){
    showConnectDialog([{step:`正在尝试恢复与「${escapeHtml(contactDisplayText(c))}」的连接…`, body:`
      <p style="font-size:12px;color:var(--mut)">尝试复用上一次尚存的直连通道，无需交换码（仅双方页面都未关闭时可能成功）…</p>
      <div class="mi-note" id="reviveStatus">尝试中…</div>`}]);
    const ok = await attemptRevive(currentId);
    if(ok){ toast("已恢复连接"); return; } // finalizeChannel 会关弹窗并切换视图
    const rs=document.getElementById('reviveStatus');
    if(rs) rs.textContent="恢复失败，转为重新交换连接码。";
  }
  // 2) 回退到手动交换
  showConnectDialog([
    {step:`重新交换连接码 · 与「${escapeHtml(contactDisplayText(c))}」重连`, body:`
      <p style="font-size:12px;color:var(--mut)">恢复失败（页面已刷新或对端已关闭）。因 WebRTC 会话信息每次临时生成，需双方重新交换一次连接码。联系人信息与历史记录会自动延续。</p>
      <div class="row">
        <button onclick="startInvite()">我发起（生成邀请码）</button>
        <button class="ghost" onclick="startAccept()">我接受（粘贴邀请码）</button>
      </div>`}
  ]);
}
/* 在存活的 PC 上重新打开 DataChannel，成功则免交换码恢复 */
function attemptRevive(contactId){
  return new Promise(res=>{
    if(connections.has(contactId)){ res(true); return; } // 已连接
    const pc = revivable.get(contactId);
    if(!pc){ res(false); return; }
    if(pc.iceConnectionState!=='connected' && pc.iceConnectionState!=='completed'){
      try{ pc.close(); }catch(e){}
      revivable.delete(contactId);
      res(false); return;
    }
    let chatCh, fileCh;
    try{
      chatCh = pc.createDataChannel('chat',{ordered:true});
      fileCh = pc.createDataChannel('file',{ordered:true});
    }
    catch(e){ res(false); return; }
    let opened=0;
    const to=setTimeout(()=>{ try{chatCh.close();fileCh.close();}catch(e){} res(false); }, 5000);
    const onOpen=(ch,isC)=>{ opened++; bindChannel(ch, pc, null, null, isC); if(opened>=2){ clearTimeout(to); res(true); } };
    chatCh.onopen=()=>onOpen(chatCh, true);
    fileCh.onopen=()=>onOpen(fileCh, false);
    chatCh.onerror=()=>{ clearTimeout(to); res(false); };
    fileCh.onerror=()=>{ clearTimeout(to); res(false); };
  });
}

/* 邀请方：生成邀请码 */
async function startInvite(){
  pendingRole='offer';
  showConnectDialog([{step:"第 1 步 · 正在生成邀请码", body:`
    <div class="gen-loading"><span class="spinner"></span>正在创建加密连接、收集 STUN 反射地址…</div>`}]);
  cleanupPending();
  const pc = newPC(); pendingPC = pc;
  const chatCh = pc.createDataChannel("chat",{ordered:true});
  const fileCh = pc.createDataChannel("file",{ordered:true});
  pendingChannel = chatCh;
  bindChannel(chatCh, pc, null, null, true);
  bindChannel(fileCh, pc, null, null, false);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitIceComplete(pc);
  if(pendingPC !== pc) return; // 用户在等待期间点了取消，中止生成
  startConnectWatchdog(pc, "连接");
  const mdnsWarn = hasRealHostCandidate(pc) ? '' :
    '<div class="mi-note">ℹ 本机真实 IP 被 mDNS 隐藏（*.local），已通过 STUN 辅助获取反射地址以保障连接。</div>';
  const code = encodeSignal({type:"offer", sdp: pc.localDescription, identity: store.identity, ips: extractIpsFromPc(pc)});
  showConnectDialog([
    {step:"第 1 步（共 3 步） · 你是邀请方", body:`
      <p style="font-size:12px;color:var(--mut)">把下面的<b>邀请码</b>发给对方（任意聊天工具），让对方点「接受连接」并粘贴。</p>
      <textarea class="codebox" id="codeOut" readonly>${code}</textarea>
      ${mdnsWarn}
      <div class="row"><button onclick="copyText(document.getElementById('codeOut').value)">复制邀请码</button></div>`},
    {step:"第 3 步 · 等对方回发应答码后粘贴", body:`
      <textarea class="codebox" id="codeIn" placeholder="在此粘贴对方回发的应答码..."></textarea>
      <div class="row"><button onclick="finalizeOffer()">完成连接</button></div>`}
  ]);
}
async function finalizeOffer(){
  const s = document.getElementById('codeIn').value.trim();
  if(!s) return toast("请粘贴应答码");
  const pc = pendingPC;
  if(!pc) return toast("连接已取消，请重新开始");
  try{
    const obj = decodeSignal(s);
    if(obj.type!=='answer') return toast("这不是应答码");
    pendingPeerIps = Array.isArray(obj.ips) ? obj.ips : null; // 暂存对端真实 IP
    await pc.setRemoteDescription(new RTCSessionDescription(obj.sdp));
    if(pendingPC !== pc) return; // 用户在等待期间点了取消，中止
    toast("已提交，正在建立连接…", 3000);
    document.getElementById('dlgConnect').classList.remove('show');
    startConnectWatchdog(pc, "连接");
  }catch(e){ toast("应答码无效: "+e.message); }
}

/* 被邀方：粘贴邀请码，生成应答码 */
async function startAccept(){
  pendingRole='answer';
  cleanupPending();
  showConnectDialog([
    {step:"第 2 步 · 你是被邀方", body:`
      <p style="font-size:12px;color:var(--mut)">粘贴对方发来的<b>邀请码</b>：</p>
      <textarea class="codebox" id="codeIn" placeholder="在此粘贴邀请码..."></textarea>
      <div class="row"><button onclick="acceptOffer()">生成应答码</button></div>`},
    {step:"生成后 · 把应答码回发给对方", body:`
      <textarea class="codebox" id="codeOut" readonly placeholder="应答码将显示在这里..."></textarea>
      <div class="row"><button onclick="copyText(document.getElementById('codeOut').value)">复制应答码</button></div>`}
  ]);
}
async function acceptOffer(){
  const s = document.getElementById('codeIn').value.trim();
  if(!s) return toast("请粘贴邀请码");
  try{
    const obj = decodeSignal(s);
    if(obj.type!=='offer') return toast("这不是邀请码");
    pendingPeerIps = Array.isArray(obj.ips) ? obj.ips : null; // 暂存对端真实 IP
    // 立即显示生成中提示，避免用户以为点击无反应（STUN 收集候选需要网络往返）
    const co=document.getElementById('codeOut');
    if(co){ co.value='⏳ 正在生成应答码，收集 STUN 反射地址…'; }
    toast("正在生成应答码…", 3000);
    const pc = newPC(); pendingPC = pc;
    pc.ondatachannel = e=>{
      if(e.channel.label==='chat'){
        pendingChannel = e.channel;
        bindChannel(e.channel, pc, obj.identity.id, obj.identity.name, true);
      } else if(e.channel.label==='file'){
        bindChannel(e.channel, pc, null, null, false);
      }
    };
    await pc.setRemoteDescription(new RTCSessionDescription(obj.sdp));
    const ans = await pc.createAnswer();
    await pc.setLocalDescription(ans);
    await waitIceComplete(pc);
    if(pendingPC !== pc) return; // 用户在等待期间点了取消，中止生成
    startConnectWatchdog(pc, "连接");
    if(!hasRealHostCandidate(pc)) toast("ℹ 本机真实 IP 被 mDNS 隐藏，已通过 STUN 辅助获取反射地址", 5000);
    const code = encodeSignal({type:"answer", sdp: pc.localDescription, identity: store.identity, ips: extractIpsFromPc(pc)});
    document.getElementById('codeOut').value = code;
    toast("已生成应答码，请复制回发给对方");
  }catch(e){ toast("邀请码无效: "+e.message); }
}

function bindChannel(channel, pc, knownPeerId, knownPeerName, isChat){
  channel.binaryType='arraybuffer'; // 接收文件分块用 ArrayBuffer
  channelMap.set(channel, {pc, contactId: knownPeerId||null, isChat: !!isChat});
  channel.onopen = ()=> onChannelOpen(channel, knownPeerId, knownPeerName, !!isChat);
  channel.onmessage = e=> onChannelMsg(channel, e.data);
  channel.onclose = ()=> onChannelClose(channel);
  channel.onerror = ()=> onChannelClose(channel);
  // ICE 状态监听仅 chat 通道绑定（避免 file 通道重复触发）
  if(isChat){
    pc.oniceconnectionstatechange = ()=>{
      const st = pc.iceConnectionState;
      if(st==='failed'){ clearConnectWatchdog(); toast("ICE 连接失败：请确认双方在同一局域网或均有公网 IP，并放行入站 UDP；STUN 已启用，若仍失败请检查网络能否访问 STUN 服务器", 7000); onChannelClose(channel); }
      else if(st==='disconnected'){ toast("连接中断，尝试恢复中..."); }
    };
  }
}

function onChannelOpen(channel, peerId, peerName, isChat){
  if(!isChat){
    // file 通道打开：如果 chat 已登记，将 file 通道补连到 connections
    const info = channelMap.get(channel);
    if(!info) return;
    for(const [ch, inf] of channelMap){
      if(inf.pc===info.pc && inf.isChat && inf.contactId){
        const conn = connections.get(inf.contactId);
        if(conn && !conn.file){
          conn.file = channel;
          info.contactId = inf.contactId;
        }
        break;
      }
    }
    return;
  }
  // 发送本机身份
  try{ channel.send(JSON.stringify({type:"hello", identity: store.identity})); }catch(e){}
  if(peerId){
    // 被邀方：邀请码里已带邀请方身份，直接登记
    finalizeChannels(channel, peerId, peerName);
  }else{
    // 邀请方：需等对端 hello 才知道身份
    toast("连接已建立，等待对端身份...");
  }
}
function onChannelMsg(channel, data){
  // 二进制：文件/图片分块（仅 file 通道收发）
  if(typeof data !== 'string'){
    const info=channelMap.get(channel);
    if(info && info.incomingFile){
      info.incomingFile.chunks.push(data);
      info.incomingFile.received += data.byteLength;
      updateFileProgress(info.incomingFile.fid);
    }else if(info && info.incomingImage){
      info.incomingImage.chunks.push(data);
      info.incomingImage.received += data.byteLength;
      updateImageProgress(info.incomingImage.iid);
    }
    return;
  }
  let m; try{ m=JSON.parse(data); }catch{ return; }
  if(m.type==='hello'){
    const info=channelMap.get(channel);
    // 已连接的同联系人发来 hello（改名同步）：仅更新用户名，不重走连接流程
    if(info && info.contactId && info.contactId===m.identity.id && connections.has(info.contactId)){
      const c=getContact(info.contactId);
      if(c){ c.peerName=m.identity.name||c.peerName; c.lastSeen=nowTs(); saveStore(); renderContacts(); if(info.contactId===currentId) renderTopbar(); }
      return;
    }
    finalizeChannels(channel, m.identity.id, m.identity.name);
    return;
  }
  const info = channelMap.get(channel);
  const cId = info && info.contactId;
  if(!cId) return; // 身份未确认前丢弃业务消息
  if(m.type==='msg'){
    addMessage(cId, 'in', m.text, m.ts);
    if(cId===currentId) sendReadReceipt(cId);
    // 处理序列号 + 发 ACK
    const conn = connections.get(cId);
    if(conn && typeof m.seq==='number'){
      conn.inSeq = Math.max(conn.inSeq, m.seq+1);
      sendAck(cId, conn.inSeq-1);
    }
  }
  else if(m.type==='file-meta'){ startReceiveFile(cId, info, m); if(cId===currentId) sendReadReceipt(cId); }
  else if(m.type==='file-end'){ finishReceiveFile(cId, info, m.fid); }
  else if(m.type==='image-meta'){ startReceiveImage(cId, info, m); if(cId===currentId) sendReadReceipt(cId); }
  else if(m.type==='image-end'){ finishReceiveImage(cId, info, m.iid); }
  else if(m.type==='read'){
    const c = getContact(cId);
    if(c){ c.peerReadTs = m.ts; saveStore(); if(cId===currentId) requestAnimationFrame(()=>refreshMessageReadStatus(cId)); }
  }
  else if(m.type==='ack'){
    const conn = connections.get(cId);
    if(conn){
      for(const [seq, p] of conn.pending){
        if(seq <= m.seq){ clearTimeout(p.timer); conn.pending.delete(seq); }
      }
    }
    const c = getContact(cId);
    if(c){ c.peerDeliveredTs = nowTs(); saveStore(); if(cId===currentId) requestAnimationFrame(()=>refreshMessageReadStatus(cId)); }
  }
  else if(m.type==='delivered'){
    const c = getContact(cId);
    if(c && (!c.peerDeliveredTs || m.ts > c.peerDeliveredTs)){
      c.peerDeliveredTs = m.ts; saveStore(); if(cId===currentId) requestAnimationFrame(()=>refreshMessageReadStatus(cId));
    }
  }
  else if(m.type==='bye'){ appendSys(cId,"对方已断开"); peerBye.add(cId); }
  // 收到消息发已送达回执（msg 已通过 ACK 覆盖，此处仅对无 seq 消息和 file-meta 等发 delivered）
  if(m.type!=='delivered' && m.type!=='read' && m.type!=='ack'){
    // 仅非 msg 或旧版无 seq 的 msg 发 delivered（新版 msg 走 ACK）
    if(m.type!=='msg' || typeof m.seq!=='number') sendDeliveredReceipt(cId);
  }
}
function finalizeChannels(chatCh, peerId, peerName){
  const chatInfo = channelMap.get(chatCh);
  if(!chatInfo) return;
  const pc = chatInfo.pc;
  // 查找同一 PC 上的 file 通道（可能尚未到达，由 onChannelOpen 补连）
  let fileCh = null;
  for(const [ch, info] of channelMap){
    if(info.pc===pc && !info.isChat){ fileCh = ch; break; }
  }
  const oldId = chatInfo.contactId;
  if(oldId && oldId!==peerId){
    const oc = connections.get(oldId);
    if(oc){ for(const [seq,p] of oc.pending) clearTimeout(p.timer); oc.pending.clear(); }
    connections.delete(oldId);
  }
  // 在 channelMap 中对两个通道写入 contactId
  chatInfo.contactId = peerId;
  if(fileCh){ const fi = channelMap.get(fileCh); if(fi) fi.contactId = peerId; }
  const c = ensureContact(peerId, peerName);
  connections.set(peerId, {chat: chatCh, file: fileCh, pc, outSeq:0, inSeq:0, pending:new Map()});
  revivable.delete(peerId); peerBye.delete(peerId); cancelAutoRevive(peerId);
  if(pendingPC===pc) pendingPC=null;
  pendingChannel=null;
  clearConnectWatchdog();
  c.lastSeen = nowTs();
  if(pendingPeerIps && pendingPeerIps.length){ c.peerIps = pendingPeerIps; }
  pendingPeerIps = null;
  detectPeerIp(pc, peerId);
  saveStore();
  closeDialog('dlgConnect');
  selectContact(peerId);
  if(!oldId) appendSys(peerId, "✅ 已建立加密直连");
  toast("已连接 "+contactDisplayText(c));
  // 自动发送离线期间排队的消息
  flushPendingMessages(peerId);
}
function currentConnId(){ // 当前选中且已连接
  if(currentId && connections.has(currentId)) return currentId;
  return null;
}
function onChannelClose(channel){
  const info = channelMap.get(channel); if(!info) return;
  const cId = info.contactId;
  const pc = info.pc;
  channelMap.delete(channel);
  if(!cId) return;
  const conn = connections.get(cId);
  if(!conn) return;
  // 断开当前通道
  if(info.isChat && conn.chat===channel) conn.chat = null;
  else if(!info.isChat && conn.file===channel) conn.file = null;
  // 两个通道都断开才算真正断开
  if(!conn.chat && !conn.file){
    // 清理 pending 定时器
    for(const [seq, p] of conn.pending) clearTimeout(p.timer);
    conn.pending.clear();
    connections.delete(cId);
    // 保留底层 PC 以便尝试免交换码恢复
    if(pc && pc.iceConnectionState!=='closed'){ revivable.set(cId, pc); }
    if(cId===currentId){ appendSys(cId,"连接已断开"); renderChat(); }
    renderContacts();
    if(revivable.has(cId) && !peerBye.has(cId) && !autoReviveTimers.has(cId)){
      scheduleAutoRevive(cId);
    }
  }
}
function scheduleAutoRevive(cId){
  const delay = 2500 + Math.floor(Math.random()*2000); // 2.5~4.5s 随机抖动，降低双方同时触发
  const t = setTimeout(async ()=>{
    autoReviveTimers.delete(cId);
    if(connections.has(cId)) return; // 已恢复或已重连
    if(!revivable.has(cId)) return;
    appendSys(cId, "↻ 正在尝试自动恢复连接…");
    const ok = await attemptRevive(cId);
    if(!ok && cId===currentId){
      appendSys(cId, "自动恢复失败，可点「⚡ 重连」手动交换连接码");
      renderChat();
    }
  }, delay);
  autoReviveTimers.set(cId, t);
}
function cancelAutoRevive(cId){
  const t=autoReviveTimers.get(cId);
  if(t){ clearTimeout(t); autoReviveTimers.delete(cId); }
}
function cleanupPending(){
  clearConnectWatchdog();
  if(pendingPC){
    // 清理 pendingPC 上的所有通道
    for(const [ch,info] of channelMap){ if(info.pc===pendingPC){ try{ch.close();}catch(e){} channelMap.delete(ch); } }
    try{ pendingPC.close(); }catch(e){}
    pendingPC=null;
  }
  pendingChannel=null;
  pendingPeerIps=null;
}
async function detectPeerIp(pc, contactId){
  try{
    await new Promise(r=>setTimeout(r,500));
    const stats = await pc.getStats();
    let ip="", ctype="";
    stats.forEach(r=>{
      if(r.type==='candidate-pair' && r.selected){
        const rem = stats.get(r.remoteCandidateId);
        if(rem){
          if(rem.address) ip = rem.address; else if(rem.ip) ip = rem.ip;
          ctype = rem.candidateType || ''; // host / srflx / prflx / relay
        }
      }
    });
    // mDNS 混淆下 getStats 可能拿到 *.local：回退用信令里对端真实 IP 显示，并标记 ipType='signal'
    if(!ip || ip.endsWith('.local')){
      const c0=getContact(contactId);
      const sig = c0 && c0.peerIps && c0.peerIps.find(isRealIp);
      if(sig){ ip=sig; ctype='signal'; }
    }
    if(ip){
      const c=getContact(contactId);
      if(c){ c.ip=ip; c.ipType=ctype; c.lastSeen=nowTs(); saveStore(); renderContacts(); if(contactId===currentId){ renderTopbar(); if(document.getElementById('dIpInfo')) renderDetailIpInfo(c); } }
    }
  }catch(e){}
}
function ipModeLabel(ctype){
  // 仅直连模式：host/prflx 为直连；开启 STUN 辅助时可能出现 srflx；signal 为信令回退显示
  if(ctype==='host'||ctype==='prflx') return '直连';
  if(ctype==='srflx') return 'STUN';
  if(ctype==='signal') return '信令';
  return ctype||'';
}

/* ===================== 已读回执 / ACK ===================== */
function sendReadReceipt(contactId){
  const conn = connections.get(contactId);
  if(!conn || !conn.chat) return;
  const ts = nowTs();
  try{ conn.chat.send(JSON.stringify({type:"read", ts})); }catch(e){}
}
function sendDeliveredReceipt(contactId){
  const conn = connections.get(contactId);
  if(!conn || !conn.chat) return;
  const ts = nowTs();
  try{ conn.chat.send(JSON.stringify({type:"delivered", ts})); }catch(e){}
}
function sendAck(cId, seq){
  const conn = connections.get(cId);
  if(!conn || !conn.chat) return;
  try{ conn.chat.send(JSON.stringify({type:"ack", seq})); }catch(e){}
}
function retransmitMsg(cId, seq){
  const conn = connections.get(cId);
  if(!conn) return;
  const p = conn.pending.get(seq);
  if(!p) return; // 已被 ACK 确认
  if(p.retries >= 3){
    conn.pending.delete(seq);
    if(cId===currentId) appendSys(cId, "⚠ 消息发送失败（已重试3次）");
    return;
  }
  p.retries++;
  try{ conn.chat.send(JSON.stringify({type:"msg", ts:p.ts, text:p.text, seq})); }catch(e){}
  p.timer = setTimeout(()=>retransmitMsg(cId, seq), 3000 * Math.pow(2, p.retries));
}
function refreshMessageReadStatus(contactId){
  const c = getContact(contactId);
  if(!c) return;
  const msgs = document.getElementById('messages').querySelectorAll('.read-tag');
  msgs.forEach(rd=>{
    const ts = parseInt(rd.getAttribute('data-ts'));
    if(c.peerReadTs && ts <= c.peerReadTs){ rd.textContent='✓已读'; }
    else if(c.peerDeliveredTs && ts <= c.peerDeliveredTs){ rd.textContent='✓已送达'; }
  });
}

/* 发送消息 */
function sendMsg(){
  const ta=document.getElementById('inputMsg');
  const text=ta.value.trim(); if(!text) return;
  const cId=currentId; // 用 currentId 允许离线发送
  if(!cId) return toast("请先选择联系人");
  const conn = connections.get(cId);
  const online = conn && conn.chat;
  // 离线：标记 pending，等连接恢复后自动发送
  if(!online){
    const ts=nowTs();
    addPendingMessage(cId, 'out', text, ts);
    ta.value='';
    return;
  }
  // 在线：正常发送
  if(conn.chat.bufferedAmount > 64*1024) return toast("网络拥塞，稍后重试");
  const ts=nowTs();
  const seq = conn.outSeq++;
  const msg = {type:"msg", ts, text, seq};
  try{ conn.chat.send(JSON.stringify(msg)); }catch(e){ return toast("发送失败: "+e.message); }
  // 加入重传队列（3s 后若未收到 ACK 则重发）
  const timer = setTimeout(()=>retransmitMsg(cId, seq), 3000);
  conn.pending.set(seq, {text, ts, timer, retries:0});
  addMessage(cId,'out',text,ts); // 正常消息用 addMessage（不带 pending 标记）
  ta.value='';
}
function addPendingMessage(contactId, dir, text, ts){
  if(!store.messages[contactId]) store.messages[contactId]=[];
  store.messages[contactId].push({ts, dir, text, pending:true});
  saveStore();
  if(contactId===currentId) renderMessages();
  renderContacts();
}
/* 连接建立后，自动发送所有离线期间排队的消息 */
function flushPendingMessages(contactId){
  const conn = connections.get(contactId);
  if(!conn || !conn.chat) return;
  const arr = store.messages[contactId]||[];
  let flushed = false;
  for(const m of arr){
    if(m.pending && m.dir==='out'){
      flushed = true;
      const seq = conn.outSeq++;
      try{ conn.chat.send(JSON.stringify({type:"msg", ts:m.ts, text:m.text, seq})); }catch(e){ continue; }
      const timer = setTimeout(()=>retransmitMsg(contactId, seq), 3000);
      conn.pending.set(seq, {text:m.text, ts:m.ts, timer, retries:0});
      delete m.pending;
    }
  }
  if(flushed){
    saveStore();
    if(contactId===currentId) renderMessages();
    appendSys(contactId, "↻ 已自动发送离线消息");
  }
}
function addMessage(contactId, dir, text, ts){
  if(!store.messages[contactId]) store.messages[contactId]=[];
  store.messages[contactId].push({ts:ts||nowTs(), dir, text});
  const c=getContact(contactId); if(c) c.lastSeen=ts||nowTs();
  if(dir==='in' && contactId!==currentId){ store.unread[contactId]=(store.unread[contactId]||0)+1; }
  saveStore();
  if(contactId===currentId) renderMessages();
  renderContacts();
}
function appendSys(contactId, text){
  if(!store.messages[contactId]) store.messages[contactId]=[];
  store.messages[contactId].push({ts:nowTs(), dir:'sys', text});
  saveStore();
  if(contactId===currentId) renderMessages();
}

/* ===================== 文件传输 ===================== */
const FILE_CHUNK = 16*1024;            // 16KB 分块（兼容 SCTP 默认消息上限）
const FILE_BUF_HIGH = 8*1024*1024;     // 背压高水位 8MB
const fileTransfers = new Map();       // fid -> {received,size,dir,contactId,name} 进度（出/入共用）
const fileUrls = new Map();            // fid -> objectURL（运行时下载链接，不持久化）

function pickFile(){ document.getElementById('fileSendInput').click(); }
document.getElementById('fileSendInput').addEventListener('change', e=>{
  try{
    const f=e.target.files[0]; e.target.value=''; if(!f) return;
    sendFile(f).catch(err=>{ console.error('sendFile:',err); toast('文件发送异常'); });
  }catch(err){ console.error('file input:',err); toast('操作失败'); }
});
/* 图片发送 input 监听 */
document.getElementById('imageSendInput').addEventListener('change', e=>{
  try{
    const f=e.target.files[0]; e.target.value=''; if(!f) return;
    sendImage(f).catch(err=>{ console.error('sendImage:',err); toast('图片发送异常'); });
  }catch(err){ console.error('image input:',err); toast('操作失败'); }
});
function fmtSize(n){
  if(n<1024) return n+' B';
  if(n<1048576) return (n/1024).toFixed(1)+' KB';
  if(n<1073741824) return (n/1048576).toFixed(1)+' MB';
  return (n/1073741824).toFixed(2)+' GB';
}
async function sendFile(file){
  const cId=currentConnId();
  const conn = connections.get(cId);
  if(!conn || !conn.file) return toast("未连接，无法发送文件");
  const channel=conn.file;
  if(!channel.bufferedAmountLowThreshold || channel.bufferedAmountLowThreshold<1*1024*1024) channel.bufferedAmountLowThreshold=1*1024*1024;
  const fid=randId();
  const meta={type:"file-meta", fid, name:file.name, size:file.size, mime:file.type||'application/octet-stream'};
  try{ channel.send(JSON.stringify(meta)); }catch(e){ return toast("发送失败: "+e.message); }
  fileTransfers.set(fid,{received:0,size:file.size,dir:'out',contactId:cId,name:file.name});
  addFileMessage(cId,'out',meta);
  let offset=0;
  try{
    while(offset<file.size){
      const buf=await file.slice(offset, offset+FILE_CHUNK).arrayBuffer();
      // 背压：缓冲过高时等 bufferedamountlow 事件
      while(channel.bufferedAmount > FILE_BUF_HIGH){
        await new Promise(r=>{ const h=()=>{channel.removeEventListener('bufferedamountlow',h); r();}; channel.addEventListener('bufferedamountlow',h); });
      }
      channel.send(buf);
      offset+=buf.byteLength;
      const st=fileTransfers.get(fid); if(st){ st.received=offset; updateFileProgress(fid); }
    }
    channel.send(JSON.stringify({type:"file-end", fid}));
  }catch(e){ toast("文件发送失败: "+e.message); }
  finally{ fileTransfers.delete(fid); }
}
function startReceiveFile(cId, info, m){
  info.incomingFile={fid:m.fid, name:m.name, size:m.size, mime:m.mime, received:0, chunks:[]};
  fileTransfers.set(m.fid,{received:0,size:m.size,dir:'in',contactId:cId,name:m.name});
  addFileMessage(cId,'in',m);
}
function finishReceiveFile(cId, info, fid){
  const inc=info.incomingFile; info.incomingFile=null;
  fileTransfers.delete(fid);
  if(!inc || inc.fid!==fid) return;
  const blob=new Blob(inc.chunks,{type:inc.mime||'application/octet-stream'});
  fileUrls.set(fid, URL.createObjectURL(blob));
  if(cId===currentId){
    const el=document.getElementById('file-'+fid);
    if(el) renderFileCardInto(el,{fid,name:inc.name,size:inc.size,dir:'in'});
  }
}
function addFileMessage(contactId, dir, meta){
  if(!store.messages[contactId]) store.messages[contactId]=[];
  const item={ts:nowTs(), dir, file:{fid:meta.fid, name:meta.name, size:meta.size}};
  store.messages[contactId].push(item);
  const c=getContact(contactId); if(c) c.lastSeen=item.ts;
  if(dir==='in' && contactId!==currentId){ store.unread[contactId]=(store.unread[contactId]||0)+1; }
  saveStore();
  if(contactId===currentId) renderMessages();
  renderContacts();
}
function renderFileCardInto(el, f){
  const st=fileTransfers.get(f.fid);
  const url=fileUrls.get(f.fid);
  const transferring=!!st;
  const pct = st && st.size ? Math.min(100, Math.round(st.received/st.size*100)) : 0;
  let right='';
  if(url){ right=`<a href="${url}" download="${escapeHtml(f.name)}">下载</a>`; }
  else if(f.dir==='out' && !transferring){ right=`<span class="fs">已发送</span>`; }
  else if(f.dir==='in' && !transferring){ right=`<span class="fs">（已失效）</span>`; }
  const info = transferring
    ? `<div class="fs"><span class="fl-pct">${pct}%</span> · ${fmtSize(st.received)}/${fmtSize(f.size)}</div><div class="prog"><i style="width:${pct}%"></i></div>`
    : `<div class="fs">${fmtSize(f.size)}</div>`;
  const readTag = f.dir==='out' && f.ts ? `<span class="read-tag" data-ts="${f.ts}"></span>` : '';
  el.innerHTML=`<div class="file-card"><span class="fi">📎</span><div class="fc-info"><div class="fn">${escapeHtml(f.name)}</div>${info}</div><div>${right}${readTag}</div></div>`;
}
function updateFileProgress(fid){
  const st=fileTransfers.get(fid); if(!st) return;
  if(st.contactId!==currentId) return;
  const el=document.getElementById('file-'+fid); if(!el) return;
  const pct = st.size ? Math.min(100, Math.round(st.received/st.size*100)) : 100;
  const prog=el.querySelector('.prog>i'); if(prog) prog.style.width=pct+'%';
  const lp=el.querySelector('.fl-pct'); if(lp) lp.textContent=pct+'%';
}

/* ===================== 图片传输（内嵌显示） ===================== */
const imageTransfers = new Map();  // iid -> {received,size,dir,contactId,name}（同 fileTransfers 模式）
const imageUrls = new Map();       // iid -> objectURL（运行时，不持久化）

function pickImage(){ document.getElementById('imageSendInput').click(); }
async function sendImage(file){
  if(!file.type.startsWith('image/')) return toast("请选择图片文件");
  const cId=currentConnId();
  const conn = connections.get(cId);
  if(!conn || !conn.file) return toast("未连接，无法发送图片");
  const channel=conn.file;
  if(!channel.bufferedAmountLowThreshold || channel.bufferedAmountLowThreshold<1*1024*1024) channel.bufferedAmountLowThreshold=1*1024*1024;
  const iid=randId();
  const meta={type:"image-meta", iid, name:file.name, size:file.size, mime:file.type||'image/png'};
  try{ channel.send(JSON.stringify(meta)); }catch(e){ return toast("发送失败: "+e.message); }
  imageTransfers.set(iid,{received:0,size:file.size,dir:'out',contactId:cId,name:file.name});
  imageUrls.set(iid, URL.createObjectURL(file)); // 发送方立即显示缩略图
  addImageMessage(cId,'out',meta);
  let offset=0;
  try{
    while(offset<file.size){
      const buf=await file.slice(offset, offset+FILE_CHUNK).arrayBuffer();
      while(channel.bufferedAmount > FILE_BUF_HIGH){
        await new Promise(r=>{ const h=()=>{channel.removeEventListener('bufferedamountlow',h); r();}; channel.addEventListener('bufferedamountlow',h); });
      }
      channel.send(buf);
      offset+=buf.byteLength;
      const st=imageTransfers.get(iid); if(st){ st.received=offset; updateImageProgress(iid); }
    }
    channel.send(JSON.stringify({type:"image-end", iid}));
  }catch(e){ toast("图片发送失败: "+e.message); }
  finally{ imageTransfers.delete(iid); }
}
function startReceiveImage(cId, info, m){
  info.incomingImage={iid:m.iid, name:m.name, size:m.size, mime:m.mime, received:0, chunks:[]};
  imageTransfers.set(m.iid,{received:0,size:m.size,dir:'in',contactId:cId,name:m.name});
  addImageMessage(cId,'in',m);
}
function finishReceiveImage(cId, info, iid){
  const inc=info.incomingImage; info.incomingImage=null;
  imageTransfers.delete(iid);
  if(!inc || inc.iid!==iid) return;
  const blob=new Blob(inc.chunks,{type:inc.mime||'image/png'});
  imageUrls.set(iid, URL.createObjectURL(blob));
  if(cId===currentId){
    const el=document.getElementById('img-'+iid);
    if(el) renderImageInto(el,{iid,name:inc.name,size:inc.size,dir:'in'});
  }
}
function addImageMessage(contactId, dir, meta){
  if(!store.messages[contactId]) store.messages[contactId]=[];
  const item={ts:nowTs(), dir, image:{iid:meta.iid, name:meta.name, size:meta.size}};
  store.messages[contactId].push(item);
  const c=getContact(contactId); if(c) c.lastSeen=item.ts;
  if(dir==='in' && contactId!==currentId){ store.unread[contactId]=(store.unread[contactId]||0)+1; }
  saveStore();
  if(contactId===currentId) renderMessages();
  renderContacts();
}
function renderImageInto(el, img){
  const url=imageUrls.get(img.iid);
  const st=imageTransfers.get(img.iid);
  const transferring=!!st;
  let body='';
  if(url){
    body=`<img src="${url}" alt="${escapeHtml(img.name)}" onclick="if(this.src)window.open(this.src)" title="点击查看原图">`;
  }else if(transferring){
    const pct = st && st.size ? Math.min(100, Math.round(st.received/st.size*100)) : 0;
    body=`<div class="img-expired"><div style="text-align:center"><span class="spinner" style="margin-right:6px"></span>${pct}%</div></div>`;
  }else{
    body=`<div class="img-expired">（图片已失效 · ${fmtSize(img.size)}）</div>`;
  }
  const readTag = img.dir==='out' && img.ts ? `<span class="read-tag" data-ts="${img.ts}"></span>` : '';
  el.innerHTML=body+`<div class="img-info">${fmtTime(img.ts||nowTs())}${readTag}</div>`;
}
function updateImageProgress(iid){
  const st=imageTransfers.get(iid); if(!st) return;
  if(st.contactId!==currentId) return;
  const el=document.getElementById('img-'+iid); if(!el) return;
  const pct = st.size ? Math.min(100, Math.round(st.received/st.size*100)) : 100;
  const exp=el.querySelector('.img-expired>div');
  if(exp) exp.textContent=pct+'%';
}

/* ===================== 渲染 ===================== */
function renderAll(){ updateMobileView(); renderContacts(); renderChat(); renderIdentity(); }
function renderIdentity(){
  document.getElementById('myName').textContent = store.identity.name;
  document.getElementById('myId').textContent = store.identity.id;
}
function renderContacts(){
  const list=document.getElementById('contactList'); list.innerHTML='';
  if(store.contacts.length===0){ list.innerHTML='<div style="padding:16px;color:var(--mut);font-size:12px;text-align:center">暂无联系人<br>点「新建连接」开始</div>'; return; }
  // 按最后联系排序
  const sorted=[...store.contacts].sort((a,b)=>(b.lastSeen||0)-(a.lastSeen||0));
  for(const c of sorted){
    const div=document.createElement('div');
    div.className='contact'+(c.id===currentId?' active':'');
    const last = c.lastSeen? fmtTime(c.lastSeen):'';
    const u = store.unread[c.id]||0;
    div.innerHTML=`<span class="dot${connections.has(c.id)?' on':''}"></span>
      <div class="c-main"><div class="c-name">${contactDisplayHtml(c)}</div>
      <div class="c-ip">${c.ip?escapeHtml(c.ip):'未知 IP'}</div></div>
      <div class="c-time">${u?`<span class="badge">${u>99?'99+':u}</span>`:last}</div>`;
    div.onclick=()=>selectContact(c.id);
    list.appendChild(div);
  }
}
function renderChat(){ renderTopbar(); renderMessages(); }
function renderTopbar(){
  const btn=document.getElementById('btnDetail');
  const rc=document.getElementById('btnReconnect');
  const ta=document.getElementById('inputMsg');
  const bf=document.getElementById('btnFile');
  const bi=document.getElementById('btnImage');
  if(!currentId){ document.getElementById('topTitle').textContent='未选择联系人'; document.getElementById('topSub').textContent=''; document.getElementById('topStatus').textContent=''; document.getElementById('topStatus').className='status'; btn.style.display='none'; rc.style.display='none'; ta.disabled=true; if(bf) bf.disabled=true; if(bi) bi.disabled=true; document.getElementById('messages').innerHTML=emptyHtml(); return; }
  const c=getContact(currentId); if(!c) return;
  document.getElementById('topTitle').textContent=contactDisplayText(c);
  document.getElementById('topSub').textContent=c.ip||'未知 IP';
  const st=document.getElementById('topStatus');
  const connected=connections.has(currentId);
  if(connected){ st.textContent='● 已连接'; st.className='status connected'; ta.disabled=false; if(bf) bf.disabled=false; if(bi) bi.disabled=false; }
  else{ st.textContent='● 未连接'; st.className='status'; ta.disabled=false; if(bf) bf.disabled=true; if(bi) bi.disabled=true; } // textarea 始终可用（离线可发送 pending 消息）
  btn.style.display='';
  rc.style.display= connected? 'none':'inline-block'; // 仅未连接时显示重连按钮
  if(!connected && !hasMessages(currentId)) document.getElementById('messages').innerHTML=notConnHtml();
}
function renderMessages(){
  const box=document.getElementById('messages');
  if(!currentId){ box.innerHTML=emptyHtml(); return; }
  if(!connections.has(currentId) && !hasMessages(currentId)){ box.innerHTML=notConnHtml(); return; }
  const arr=store.messages[currentId]||[];
  box.innerHTML='';
  const c = getContact(currentId);
  const lastRead = c && c.lastReadTs;
  let dividerShown = false;
  for(const m of arr){
    // 在第一个新消息（对方发来、时间晚于 lastReadTs）前插入分界线
    if(!dividerShown && lastRead && m.dir==='in' && !m.pending && m.ts > lastRead && !m.file && !m.image){
      const div = document.createElement('div');
      div.className = 'msg-divider';
      div.textContent = '── 以下为新消息 ──';
      box.appendChild(div);
      dividerShown = true;
    }
    const el=document.createElement('div');
    if(m.dir==='sys'){ el.className='sys'; el.textContent=m.text; }
    else if(m.file){
      el.className='msg file '+(m.dir==='out'?'out':'in');
      el.id='file-'+m.file.fid;
      renderFileCardInto(el, {fid:m.file.fid, name:m.file.name, size:m.file.size, dir:m.dir, ts:m.ts});
    }
    else if(m.image){
      el.className='msg image '+(m.dir==='out'?'out':'in');
      el.id='img-'+m.image.iid;
      renderImageInto(el, {iid:m.image.iid, name:m.image.name, size:m.image.size, dir:m.dir, ts:m.ts});
    }
    else{
      el.className='msg '+(m.dir==='out'?'out':'in');
      el.dataset.ts=m.ts;
      const statusTag = m.pending
        ? '<span class="read-tag pending">⏳ 未发送</span>'
        : (m.dir==='out'?`<span class="read-tag" data-ts="${m.ts}"></span>`:'');
      el.innerHTML=escapeHtml(m.text)+`<div class="t">${fmtTime(m.ts)}${statusTag}</div>`;
    }
    box.appendChild(el);
  }
  box.scrollTop=box.scrollHeight;
  // 刷新已读回执标记
  if(currentId) refreshMessageReadStatus(currentId);
}
function hasMessages(id){ return !!(store.messages[id]&&store.messages[id].length); }
function emptyHtml(){
  return `<div id="empty"><h2>🌍 P2PChat</h2><p>基于 WebRTC 的 IPv6/IPv4 端到端加密 P2P 聊天<br>无需服务器，单文件打开即用</p>
  <p style="margin-top:14px">点左侧「新建连接」或「接受连接」开始</p></div>`;
}
function notConnHtml(){
  return `<div class="notconn" style="margin:auto"><b>未与该联系人建立连接</b><br><br>
    因 WebRTC 会话信息每次临时生成，无法凭 IP 自动重连。<br>请重新交换一次连接码：
    <div style="margin-top:10px"><button onclick="startInvite()">我发起连接</button><button class="ghost" onclick="startAccept()">我接受连接</button></div></div>`;
}

/* ===================== 对话框 ===================== */
function showConnectDialog(steps){
  const body=document.getElementById('dlgBody'); body.innerHTML='';
  for(const s of steps){
    const sec=document.createElement('div'); sec.style.marginBottom='18px';
    sec.innerHTML=`<div class="step">${s.step}</div>${s.body}`;
    body.appendChild(sec);
  }
  document.getElementById('dlgConnect').classList.add('show');
}
function closeDialog(id){ document.getElementById(id).classList.remove('show'); }
/* 取消连接向导：关闭对话框并清理握手中的 PC，使进行中的 startInvite/acceptOffer 检测到中断后中止 */
function cancelConnect(){
  closeDialog('dlgConnect');
  cleanupPending();
  pendingPeerIps = null;
}

/* 详情 */
function openDetail(){
  if(!currentId) return;
  const c=getContact(currentId);
  document.getElementById('dName').value= c.nameSet ? (c.name||'') : '';
  document.getElementById('dPeer').textContent= c.peerName || '（连接后同步）';
  document.getElementById('dIp').value=c.ip||'';
  document.getElementById('dNote').value=c.note||'';
  document.getElementById('dSeen').textContent=c.lastSeen? new Date(c.lastSeen).toLocaleString():'—';
  renderDetailIpInfo(c);
  document.getElementById('dlgDetail').classList.add('show');
}
function renderDetailIpInfo(c){
  const el=document.getElementById('dIpInfo'); if(!el) return;
  if(connections.has(c.id)){
    const mode=ipModeLabel(c.ipType);
    el.innerHTML = `当前对端地址：<b style="font-family:Consolas,monospace">${escapeHtml(c.ip||'未知')}</b>${mode?` <span class="pill">${mode}</span>`:''}`;
  }else{
    el.innerHTML = `当前对端地址：<span style="color:var(--mut)">未连接（上次：${escapeHtml(c.ip||'—')}${c.ipType?(' · '+ipModeLabel(c.ipType)):''}）</span>`;
  }
}
function saveDetail(){
  const c=getContact(currentId); if(!c) return;
  const nm=document.getElementById('dName').value.trim();
  c.name=nm;
  c.nameSet=!!nm; // 有备注才标记，空则回退显示对方用户名
  c.ip=document.getElementById('dIp').value.trim();
  c.note=document.getElementById('dNote').value;
  saveStore(); renderAll(); closeDialog('dlgDetail'); toast("已保存");
}
function deleteContact(){
  if(!currentId) return;
  if(!confirm("确定删除该联系人及其聊天记录？")) return;
  const conn = connections.get(currentId);
  if(conn){
    if(conn.chat){ const info=channelMap.get(conn.chat); if(info) channelMap.delete(conn.chat); }
    if(conn.file){ const info=channelMap.get(conn.file); if(info) channelMap.delete(conn.file); }
    try{ conn.pc.close(); }catch(e){}
    for(const [seq,p] of conn.pending) clearTimeout(p.timer);
    conn.pending.clear();
    connections.delete(currentId);
  }
  revivable.delete(currentId); cancelAutoRevive(currentId); peerBye.delete(currentId);
  store.contacts=store.contacts.filter(c=>c.id!==currentId);
  delete store.messages[currentId];
  currentId=null; saveStore(); renderAll(); closeDialog('dlgDetail'); toast("已删除");
}
function clearHistory(){
  if(!currentId) return;
  if(!confirm("清空与该联系人的聊天记录？")) return;
  store.messages[currentId]=[]; saveStore(); renderMessages(); closeDialog('dlgDetail'); toast("已清空");
}

/* 设置 */
function openSettings(){
  document.getElementById('setName').value=store.identity.name;
  document.getElementById('dlgSettings').classList.add('show');
}
function saveSettings(){
  const newName=document.getElementById('setName').value.trim();
  const changed = !!newName && newName!==store.identity.name;
  if(changed) store.identity.name=newName;
  saveStore(); renderIdentity(); closeDialog('dlgSettings'); toast("已保存");
  if(changed){ // 向所有已连接联系人同步新名字（对端收到 hello 即更新）
    const hello=JSON.stringify({type:"hello", identity: store.identity});
    connections.forEach(conn=>{ if(conn.chat) try{ conn.chat.send(hello); }catch(e){} });
  }
}

/* ===================== 账号引导 / 退出 ===================== */
let onboarding=false; // 引导态：导入成功后需关闭引导弹窗
function boot(){
  renderAll();
  refreshMyIp();
  if(isMobile()){ try{ history.pushState({p2pchat:'root'},''); }catch(e){} } // 注入根历史项，拦截列表页返回键
  if(!localStorage.getItem(STORE_KEY)){ showOnboard(); } // 首次启动无数据 → 引导
}
function showOnboard(){ document.getElementById('dlgOnboard').classList.add('show'); }
function onboardNew(){
  saveStore(); // 持久化新身份
  closeDialog('dlgOnboard');
  document.getElementById('dlgOnboardTips').classList.add('show'); // 操作提示（可跳过）
}
function onboardImport(){ onboarding=true; importJSON(); }
function logoutAccount(){
  closeDialog('dlgSettings');
  document.getElementById('dlgLogout').classList.add('show');
}
async function doLogout(backup){
  closeDialog('dlgLogout');
  if(backup) await exportJSON(); // 退出前导出一份备份（await 确保导出完成再清数据）
  localStorage.removeItem(STORE_KEY);
  channelMap.forEach(i=>{try{i.pc.close();}catch(e){}});
  connections.forEach(conn=>{ for(const [seq,p] of conn.pending) clearTimeout(p.timer); conn.pending.clear(); });
  connections.clear(); channelMap.clear(); revivable.clear(); peerBye.clear();
  autoReviveTimers.forEach(t=>clearTimeout(t)); autoReviveTimers.clear();
  currentId=null; clearConnectWatchdog();
  store=defaultStore(); // 内存占位，不保存 → 保持 localStorage 为空，下次启动仍引导
  renderAll();
  showOnboard();
  toast(backup?"已导出备份并退出账号":"已退出账号");
}

/* ===================== 导入导出 ===================== */
async function exportJSON(){
  const blob=new Blob([JSON.stringify(store,null,2)],{type:'application/json'});
  const d=new Date(); const p=n=>String(n).padStart(2,'0');
  const filename=`p2pchat-${store.identity.name}-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}.json`
    .replace(/[\\/:*?\"<>|]/g,'_'); // 过滤 Windows 文件名非法字符
  // 移动端优先 Web Share API：弹出系统分享/保存菜单，体验最可靠
  const file=new File([blob],filename,{type:'application/json'});
  try{
    if(navigator.canShare && navigator.canShare({files:[file]})){
      await navigator.share({files:[file], title:`P2PChat 备份 - ${store.identity.name}`, text:filename});
      toast("已导出"); return;
    }
  }catch(e){ if(e && e.name==='AbortError') return; /* 用户取消则结束，否则回退到下载 */ }
  // 回退：a[download]，需挂到 DOM 才能在部分移动浏览器触发
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a');
  a.href=url; a.download=filename; a.rel='noopener';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(()=>URL.revokeObjectURL(url), 2000);
  toast("已导出；若未弹出下载，请用系统浏览器打开本页再导出");
}
function importJSON(){ document.getElementById('fileInput').click(); }
document.getElementById('fileInput').addEventListener('change', e=>{
  try{
    const f=e.target.files[0]; if(!f) return;
    const r=new FileReader();
    r.onload=()=>{
      try{
        const d=JSON.parse(r.result);
        if(!d.identity || !Array.isArray(d.contacts)) throw new Error("格式不符");
        if(!confirm("导入将覆盖当前数据，是否继续？")){ onboarding=false; return; }
        store={...defaultStore(), ...d};
        if(!store.messages) store.messages={};
        if(!store.settings) store.settings={};
        if(!store.unread) store.unread={};
        store.version=4; // 仅直连，忽略历史 STUN 配置
        connections.forEach(conn=>{ for(const [seq,p] of conn.pending) clearTimeout(p.timer); conn.pending.clear(); });
        saveStore(); connections.clear(); currentId=null; renderAll(); toast("导入成功");
        if(onboarding){ onboarding=false; closeDialog('dlgOnboard'); }
      }catch(err){ toast("导入失败: "+err.message); }
    };
    r.onerror=()=>{ toast("文件读取失败"); };
    r.readAsText(f); e.target.value='';
  }catch(err){ console.error('import input:',err); toast('操作失败'); }
});

/* ===================== 工具 ===================== */
function escapeHtml(s){ return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function copyText(t){
  if(!t) return;
  if(navigator.clipboard && navigator.clipboard.writeText){
    navigator.clipboard.writeText(t).then(()=>toast("已复制")).catch(()=>fallbackCopy(t));
  } else fallbackCopy(t);
}
function fallbackCopy(t){
  const ta=document.createElement('textarea'); ta.value=t; ta.style.position='fixed'; ta.style.opacity='0';
  document.body.appendChild(ta); ta.select();
  try{ document.execCommand('copy'); toast("已复制"); }catch(e){ toast("复制失败，请手动选择复制"); }
  document.body.removeChild(ta);
}
let toastTimer=null;
function toast(msg, ms){
  const el=document.getElementById('toast'); el.textContent=msg; el.classList.add('show');
  clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'), ms||2200);
}

let exitAllowed=false; // 用户已在退出确认中选择"退出"，放行浏览器返回
window.addEventListener('popstate', ()=>{
  if(currentId){ goBack(); return; } // 聊天视图 → 回到列表
  if(isMobile() && !exitAllowed){ showExitConfirm(); return; } // 列表视图 → 拦截退出，弹确认
});
function showExitConfirm(){ document.getElementById('dlgExitConfirm').classList.add('show'); }
function confirmExit(yes){
  closeDialog('dlgExitConfirm');
  if(yes){ exitAllowed=true; try{ history.back(); }catch(e){} } // 放行，离开页面
  else { try{ history.pushState({p2pchat:'root'},''); }catch(e){} } // 取消：重新拦截下次返回
}
window.addEventListener('beforeunload', ()=>{ channelMap.forEach(i=>{try{i.pc.close();}catch(e){}}); });

/* 启动 */
boot();