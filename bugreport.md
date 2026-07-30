# 🔍 P2PChat 代码审查问题报告 (v2.7.3)

> **审查依据**: `README.md` + `doc/技术文档.md`
> **审查范围**: `js/app.js`(1239 行,全部核心逻辑)+ `index.html`
> **审查方法**: 文档承诺对照 → 静态逻辑推理 → 双验证者独立交叉确认 → 排除 2 项误报后产出 8 项真实问题
> **置信度**: 8 个问题中 8/8 高置信(≥2/2 验证通过)
> **生成日期**: 2026-07-30

---

## 一、架构与数据流总览(开发修复前请确认理解)

```mermaid
flowchart LR
    subgraph 手动信令层
        S1[startInvite: newPC<br>双 DataChannel<br>chat + file] --> S2[Offer + waitIceComplete]
        S2 --> S3[encodeSignal 邀请码<br>type=offer, sdp, identity, ips]
        S3 --> S4[手动复制粘贴]
        S4 --> S5[acceptOffer: setRemoteDescription<br>createAnswer + waitIceComplete]
        S5 --> S6[encodeSignal 应答码]
        S6 --> S7[finalizeOffer: setRemoteDescription]
    end

    subgraph 消息传输层 chat DataChannel
        M1[sendMsg: ts+seq<br>outSeq++] --> M2[pending.set(seq,<br>{timer, retries:0})]
        M2 --> M3[3s/6s/12s retransmitMsg]
        M3 --> M4{retries>=3}
        M4 -- 是 --> M5[appendSys 发送失败]
        M4 -- 否 --> M6[重发]
        M6 --> M7[onChannelMsg msg 分支]
        M7 --> M8["addMessage() → UI<br>❌ 当前无 seq 去重"]
        M8 --> M9[inSeq 更新 + sendAck]
        M9 --> M10["ack 处理: peerDeliveredTs=nowTs<br>❌ 以时间戳近似代替 seq"]
    end

    subgraph 文件层 file DataChannel
        F1[sendFile: file-meta JSON<br>❌ 当前走 file 通道<br>文档应走 chat] --> F2[16KB 分块 ArrayBuffer]
        F2 --> F3["背压等待 bufferedamountlow<br>❌ 无超时,断线永久卡"]
        F3 --> F4[file-end JSON<br>❌ 同上走了 file 通道]
    end

    style M8 fill:#ffcdd2,color:#b71c1c
    style M10 fill:#ffcdd2,color:#b71c1c
    style F3 fill:#ffcdd2,color:#b71c1c
    style F1 fill:#fff9c4,color:#f57f17
    style F4 fill:#fff9c4,color:#f57f17
    style M5 fill:#fff9c4,color:#f57f17
```

---

## 二、问题明细

### 严重等级定义
- **Major**: 必现或高概率 bug,直接影响功能可用性或用户体验
- **Minor**: 边界场景或资源问题,不会立即崩溃但需修复

---

| # | 标题 | 严重 | 触发场景 | 现象描述 | 修复建议 | 代码定位 |
|---|------|------|---------|---------|---------|---------|
| **1** | **消息重传无 seq 去重,ACK 丢失时接收方重复显示同一条消息** | Major | 网络抖动导致对端 ACK 包漏传;或发送方 3s 未收到 ACK 触发重传 | 对端 ACK 丢失后发送方重传相同 seq 消息,接收方 `onChannelMsg` 不比对已接收序号直接再次 `addMessage`,聊天界面出现重复气泡。ACK 丢失场景在弱网/频繁切换网络下非罕见。 | 在 `onChannelMsg` 的 `m.type==='msg'` 分支中,判断 `typeof m.seq === 'number'` 时:若 `m.seq < conn.inSeq` 说明已处理过——**只回 ACK(累积确认原则),不重复 addMessage、不累加 unread**。仅当 `m.seq >= conn.inSeq` 才 `addMessage` 并推进 `conn.inSeq`。 | js/app.js:464-472 |
| **2** | **发送失败提示延迟 45s(文档承诺 ~21s)** | Major | 对端完全掉线或网络不可达,ACK 零回复 | 文档 §4.2 承诺 3s→6s→12s 最多 3 次后显示失败。实际时序:初始 timer=3s(retries=0)→T=3s 重传(++1),timer=6s→T=9s 重传(++2),timer=12s→T=21s 重传(++3),timer=**24s**(多了这一轮)→T=45s 才触发 retries>=3 失败提示。用户等待 45s,体验极差。 | `retransmitMsg` 逻辑改造:先 `++retries`,**在 send 之前**判断 `if(retries >= 3)` 直接 `delete + appendSys` 并 return,不再设第 4 轮 24s 定时器。时序应为:0(首传)→3s(第1次重传 retries=1)→9s(第2次 retries=2)→21s(此时 retries 即将达 3 即判失败)。总延迟 ~21s。 | js/app.js:655-668 |
| **3** | **sendFile/sendImage 背压等待无超时,通道关闭时永久卡死** | Major | 传输大文件过程中 DataChannel 意外断开,此时 bufferedAmount > FILE_BUF_HIGH(8MB) | 背压 `while(channel.bufferedAmount > FILE_BUF_HIGH){ await addEventListener('bufferedamountlow') }` 没有超时、没有 readyState 检查、没有 close/error 事件兜底。通道关闭时 `bufferedamountlow` 永不触发,Promise 不 resolve。结果:`finally` 不执行、`fileTransfers/imageTransfers` 条目残留、文件卡片永久显示传输中、`sendFile` async 永不返回。 | 背压 Promise 加三件套:① `setTimeout(30000, ()=>{ reject(new Error('背压等待超时')) })` 每 chunk 30s 兜底 reject;② 同时监听 `channel.onclose` / `channel.onerror` 触发 reject;③ while 循环条件加 `&& channel.readyState === 'open'`。catch 块中清理 fileTransfers 并 `appendSys` 显示传输失败。 | js/app.js:794-796<br>js/app.js:877-878 |
| **4** | **仅 chat 关闭 file 存活时,retransmitMsg 抛 TypeError 后仍无限次重传** | Minor | chat 和 file 两通道非同时关闭的中间态 | `onChannelClose` 规则:**双通道都断才 delete connections**。当 chat 先断 file 未断时,`conn.chat = null`,但 `conn` 及其 `pending` Map 仍在。`retransmitMsg` 内 `conn.chat.send(...)` 抛 TypeError,被 try/catch 吞掉,**后面仍执行 `p.timer = setTimeout(...)`**,循环一直跑到 retries>=3 才结束,浪费定时器资源且延迟 ~42s 的失败提示无意义。 | 二选一或都做:① `retransmitMsg` 顶部检查 `if(!conn.chat) { clearTimeout(p.timer); conn.pending.delete(seq); return; }`;② `onChannelClose` 中将 chat 通道关闭分支追加:"`if(info.isChat) { for [seq,p] conn.pending clearTimeout(p.timer); conn.pending.clear(); }`"(推荐方案②,从源头清干净)。 | js/app.js:655-668<br>js/app.js:556-562 |
| **5** | **ACK 回执判断以时间戳近似代替 seq,未 ACK 消息被误标"已送达"** | Minor | 短时间连续发多条消息,中途收到部分 ACK | 例:seq=0 在 T=100 发送,seq=1 在 T=200 发送;T=300 收到 ack(seq=0,只确认第1条)。当前代码收到 ack 时直接 `c.peerDeliveredTs = nowTs()=300`。之后 `refreshMessageReadStatus` 判断 `msg.ts <= 300` 即标已送达,导致 seq=1(ts=200)虽然尚未 ACK 也被误判"✓已送达"。本质:把时间戳当作 seq 的代理,破坏了 ACK 累积确认语义。 | 两步改造,**同时修改持久化结构**:① contact 对象新增 `peerDeliveredSeq`、`peerReadSeq`(loadStore 中给旧数据补默认 -1);② 每条发出消息在 `store.messages[x][]` 中新增 `seq` 字段(目前仅文字消息有 seq,只对文字消息持久化即可,文件/图片用原 delivered 机制);③ 收到 `ack(seq=N)` 时,`c.peerDeliveredSeq = Math.max(c.peerDeliveredSeq, N)`;④ `refreshMessageReadStatus` 对文字消息 DOM,取 `data-seq` 与 `contact.peerDeliveredSeq` 比较。文件/图片因无 seq,保留时间戳判断。此修复要更新 `store.version` 并做迁移逻辑,改动略大,排期注意。 | js/app.js:482-491<br>js/app.js:669-678 |
| **6** | **连接看门狗 20s 超时只提示不清理 pendingPC,握手资源残留** | Minor | 用户发起连接后对端无响应;或 STUN 全部超时 | `startConnectWatchdog` 的 20s 回调只 `toast(connectDiagnose(pc),10000)`,不 `cleanupPending()`,不 `pc.close()`,不 `pendingPC=null`。结果:用户取消弹窗之前/之后 pendingPC 仍然占用内存、临时 ICE Agent 未销毁。虽然下次 `startInvite/startAccept` 会调 `cleanupPending` 覆盖,但资源残留窗口是 bug。 | 回调追加:if `pendingPC === pc` 则 `cleanupPending()`;否则单 `pc.close()` 以防 pc 已被替换但仍存活。 | js/app.js:232-241 |
| **7** | **断线状态下 deleteContact 不关闭 revivable 中的 PC,ICE 连接泄漏** | Minor | 用户与某联系人断开后(双通道都断,pc 已迁入 revivable),直接删除该联系人 | `deleteContact` 中 `conn = connections.get(currentId)`,断线状态下 conn 为 undefined(已被 onChannelClose 删除),所以跳过 `conn.pc.close()` 分支。但 revivable Map 里保留着 pc,接着 `revivable.delete(currentId)` 只删引用不 close。pc 的 ICE Agent 仍运行、占用端口和内存。虽然页面卸载会清理,但长时间运行用户泄漏累积。 | 在 `revivable.delete(currentId)` 之前补三行:`const rv = revivable.get(currentId); if(rv) { try{ rv.close(); } catch(e){} }`。同样的模式也检查一下 `finalizeChannels` 和 `attemptRevive` 里 revivable 的使用。 | js/app.js:1085-1101 |
| **8** | **file-meta/file-end/image-meta/image-end 控制消息实际走 file 通道,与文档"走 chat 通道"冲突** | Minor | 任意文件/图片传输过程 | 技术文档 §4.2 表格明确标注 `file-meta / file-end / image-meta / image-end` 走 `"chat"` DataChannel,§4.6 亦重述"元数据(...)走 chat DataChannel,二进制分块(...)走 file DataChannel"。但代码中 `sendFile/sendImage` 用的是 `const channel = conn.file`,所有 meta/end JSON 都走了 file 通道。功能无损(`onChannelMsg` 不分通道都 JSON.parse),**但违背了"双通道队头不阻塞"的设计初衷**——大文件传输时 file 通道被 16KB 分块填满,紧跟在分块后面的 file-end JSON 也会被排队,延迟了接收方 Blob 组装的触发时间。 | 推荐:**改代码,与文档一致**(文档设计是正确的,有消除队头阻塞意义):把 `sendFile` 中 `channel.send(JSON.stringify(meta))` 和 `channel.send(JSON.stringify({type:"file-end", fid}))` 改用 `conn.chat.send(...)`(需确保 `conn.chat` 存在,否则提前 return toast)。sendImage 同理。<br><br>如不想改代码则**改文档**:把 §4.2 表格的"chat"标成"file",§4.6 的描述调整为"元数据与二进制同走 file 通道,SCTP 有序队列保证先后顺序;副作用是大文件传输时 end 消息会被队头阻塞"。<br>**建议选改代码**,因为文档双通道分离是有理由的。 | js/app.js:782<br>js/app.js:786<br>js/app.js:801<br>js/app.js:865-884 |

---

## 三、已排除误报(开发无需处理)

| 原问题 | 排除原因 |
|--------|---------|
| 断线自动恢复后 pending 消息误标已送达 | pending 消息由 `addPendingMessage` 离线时生成,其 ts 是断线后时间,因此 `ts <= peerDeliveredTs` 为 false,误判不成立 |
| sendImage 默认 `mime:'image/png'` 造成 Blob 类型不符 | 前置守卫 `!file.type.startsWith('image/')` 当 `file.type` 空串时直接 return,`||'image/png'` 分支是**死代码不可达**。仅代码质量瑕疵,无功能影响 |

---

## 四、修复优先级建议

```
立即修复(Major 3 项,阻断性):
  1. 问题 3  文件传输背压永久卡(大文件+断线必现)
  2. 问题 1  消息重复显示(弱网常见)
  3. 问题 2  失败提示 45s(纯 UX,改几行就好)

本轮修复(Minor 5 项,资源/语义):
  4. 问题 8  控制消息改 chat 通道(改几行 send 调用,推荐)
  5. 问题 4  chat 先断时的重传崩溃+空转
  6. 问题 7  revivable PC 泄漏
  7. 问题 6  看门狗不清理
  8. 问题 5  ACK 时间戳近似问题(改动大,含版本迁移,建议单独 PR)
```

---

## 五、回归测试建议清单(修复后请逐项覆盖)

| 场景 | 验证点 |
|------|--------|
| 模拟对端不回 ACK | ① 发消息是否约 21s 内显示"发送失败";② 失败提示出现前重传次数≤3;③ 无 JS 控制台 TypeError |
| 丢 ACK 重传模拟(可用 Chrome DevTools 网络节流) | ① 对端聊天不出现重复气泡;② 每条消息仍回 ACK 累积确认 |
| 大文件中途断网(点浏览器开发者工具 offline) | ① sendFile 函数 30s 内退出(不永久挂);② 文件卡片显示失败/已失效;③ fileTransfers 条目被清理 |
| 连接 20s 对方无应答 | ① watchdog toast 后 pendingPC 被清理;② 再点"新建连接"不报错 |
| 联系人断开 → 删除联系人 → 长观察 10 分钟 | ① 无残留 ICE 连接(可用 chrome://webrtc-internals 观察) |
| 双通场景:边发 100MB 文件边发文字 | ① 文字消息在文件传输途中仍能即时送达(这是双通道设计的本质验证,修复问题8后尤为重要);② 文件/图片卡片的已送达标记正常 |
| 连续发 5 条短消息,收 1 条 ack(seq=2) | ① seq 0/1/2 标"✓已送达",seq 3/4 空标记(未误标)——修复问题5后的期望行为 |

---

**报告完毕**。开发人员修复后建议再次跑一轮 review 确保修改没有引入新的状态机漏洞(尤其是 ACK 去重与状态转移)。
