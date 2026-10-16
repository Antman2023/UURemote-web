# 参考 APK 协议分析

参考：`UURemote-tvProduction-3.5.0-30500-2b0f97d4-TV_gwqd.apk`，版本 3.5.0 / 30500。该文档描述从 APK 得到的静态证据，区分协议实现与真实兼容验证。

## 接入层

DEX 中 `re.h` 指定正式域名 `api.nrd.nie.163.com`，`ee.c` 构造 `X-Param-*` 请求头与 HMAC-SHA256 签名。签名输入顺序为：

```text
HTTP 方法 + 路径（含原始查询串） + 排序后的小写 x-param 头串 + 原始 JSON 请求体
```

头串以 `&` 连接 `name=value`，与前后内容直接拼接。鉴权头为 `Authorization: Bearer …`，不加入签名头串。签名材料由本地 APK 加载器按 SHA256 指纹定位；文档与浏览器构建不包含原始值。

| 原版接口 | 方法 | 来源／用途 |
| --- | --- | --- |
| `/api/v1/device/android_tv/init` | POST | `cd.b`；注册主控身份 |
| `/api/v1/qrcode/gen/login` | POST | `rb.f`；获取登录二维码 |
| `/api/v1/qrcode/login/status` | POST | `hb.d`；等待扫码状态变化 |
| `/api/v1/login/by_qrcode` | POST | `hb.g`；确认登录后获取账号令牌 |
| `/api/v1/user/info` | GET | 获取账号信息、验证已有令牌 |
| `/api/v1/device/list` | GET | `cd.a`；账号设备列表 |
| `/api/v1/app/list/of/device/{id}` | GET | 设备应用列表 |
| `/api/v1/room/join/by_device/{id}` | POST | `gf.a`；请求体为 `{"force_join":false}` |

二维码状态枚举来自 `QrCodeLoginStatus`：1 已生成、2 待确认、3 已取消、4 已确认。2026-10-16 的正式服务实测还在二维码响应中返回 `status_query_ticket`，实现会保留并回传，不打印这些令牌。

`DeviceDataJsonAdapter` 定义 `current_device`、`my_binded_devices`、`others_shared_devices`。当前 UI 接入自己的账号设备；共享设备的 `share_id` 模式尚未适配。

## 原生串流库

APK 包含 ARM64 与 ARMv7 的 `libstreamer.so` 和 `libstreamer-jni.so`。JNI 主控入口为：

```text
StreamerController.Initialize / LoginRoom / Connect
StartVideoRender / StartAudioRender
SendControlData / SendTextData / SendFileData
GetConnectionStats / Disconnect / ExitRoom
```

SDK 字符串版本为 `V1.14.22`。`libstreamer.so` 中可见 WebRTC PeerConnection、SDP、ICE、音视频编解码以及 Socket.IO 实现。浏览器版本使用浏览器 WebRTC 重写主控职责，没有尝试直接加载 Android ELF／JNI 库。

以下地址指参考 APK 的 **ARM64** 库虚拟地址，不适用于其他版本。

| 证据 | 地址／符号 |
| --- | --- |
| Socket.IO 路径与版本 | 字符串 `/socket.io/`、`?EIO=4&transport=websocket` |
| 初始信令请求头 | `0xd16ae4`：`X-NRD-AUTH`；`0xd16b6c`：`X-NRD-CONTROLLING=0` |
| `room_info` 事件 | `0xd13880`；GOT `0xf6c808` 引用事件名 |
| `control` 事件 | `0xce1e30`；GOT `0xf6c818` 引用事件名 |
| SOAC 发送 | `0xce92b8`：`client_id`、`data`、`type`、`sdp`、`ice_id`、`app_control_id` |
| Candidate 发送 | `0xcea15c`：候选地址、`sdpMid`、`sdpMLineIndex` |
| `RoomInfo::DeserializeSioMsg` | `0xe1225c` |
| `ControlResult::DeserializeSioMsg` | `0xe13648` |
| `SOAC::DeserializeSioMsg` | `0xe16008` |
| 数据通道创建 | `0xe0938c` |

`RoomConfig` 的 JSON 定义包括 `signaling_server`、`signaling_list`、`token`、`ws_connect_timeout_ms`、`streamer_retry_delta_ms`、`report_token` 和 `report_url`。

房间消息包含 `room_id`、`publisher`、`you`、`subscribers`、`reconnect_buffer`、`iceServers`。申请控制权发送二进制 `app_data`、字符串 `streamer_data` 与 `app_control_id`；返回值包含 `client_id`、`ice_id`、`iceServers`、`force_relay` 等。原生主控在 `0xcdd2cc–0xcdd2e0` 初始化空的 `streamer_data`，`0xce22a4–0xce22d8` 将其复制为 Socket.IO 字符串消息；Web 端按此发送空字符串。返回值的原生读取调用为 `get_string`。修正下述二进制附件与候选封装后，用户已确认原版电脑桌面正常显示；音频和原版键鼠操作仍待确认。

`app_data` 的 Socket.IO 二进制附件为 `04 || ConnectOptions`，不能直接发送裸 Protobuf。原生主控在 `0xce215c–0xce2198` 创建一个内容为单字节 `0x04` 的字符串，再追加 Protobuf；`sio::accept_binary_message`（`0xeae000`）将该字符串原样放入附件队列；`sio::packet::parse_buffer`（`0xeaf468`）接收附件时移除首字节。浏览器的 Engine.IO v4 不会自动添加此字节，Web 端需显式保留。该封装仅用于信令附件，不应用于 WebRTC 数据通道。

SOAC 消息格式：

```json
{
  "client_id": "对端 ID",
  "data": {
    "type": "offer",
    "sdp": "…",
    "ice_id": "当前 ICE 代次",
    "app_control_id": "当前控制会话 ID"
  }
}
```

原版五类 SCTP 通道名为 `CONTROL_DATA_CHANNEL`、`TEXT_DATA_CHANNEL`、`STREAMER_DATA_CHANNEL`、`FILE_DATA_CHANNEL`、`BINARY_DATA_CHANNEL`。当前实现创建并管理五个通道，控制数据有发送实现；文件传输、剪贴板及 STREAMER 业务消息尚未适配。视频优先协商 H.264；暂未启用 H.265。

候选消息使用嵌套格式：`data: {type: "candidate", candidate: {candidate: "candidate:…", sdpMid: "0", sdpMLineIndex: 0}, ice_id, app_control_id}`。`SOAC::DeserializeSioMsg` 的 candidate 分支先读取 `data.candidate` 的对象，再从该对象读取 candidate 字符串和两个媒体标识；发送端 `0xcea15c` 对称构造。浏览器必须先解包此对象再调用 `addIceCandidate`。

## 应用与输入协议

`com.remote.store.proto.Connect$ConnectOptions` 的字段编号：

| 字段 | 编号 |
| --- | --- |
| capture_type / type_value / capture_params | 1 / 2 / 3 |
| decoder_cap_list / force_virtual_display | 4 / 5 |
| virtual_display_modes / virtual_display_init_resolution / client_type | 6 / 7 / 8 |

桌面类型为 1，默认桌面 `type_value=-1`，Android 主控类型为 2。帧率枚举：30 FPS 为 1、60 FPS 为 2；H.264 codec_type 为 1。`Main.Message` 的序号／时间戳字段为 1／2，LaunchApp 载荷为字段 4。

`libinputmanager.so` 的 KeyboardEvent、MouseButtonCommonEvent、MouseMoveCommonEvent、MouseScrollCommonEvent 生成 JSON 控制事件，再作为二进制发送至控制数据通道：

```json
{"action":"kbd_press","key":87}
{"action":"kbd_release","key":87}
{"action":"mouse_move_absolute","abs_x":0.5,"abs_y":0.5}
{"action":"mouse_press","button":1}
{"action":"mouse_release","button":1}
{"action":"mouse_scroll","delta_x":0,"delta_y":120}
```

鼠标坐标为 0–1 分数，证据为该库 `MouseMoveCommonEvent::ApplyDisplayInfo`（`0xb0d88` / `0xb0e58`）中的坐标／显示尺寸除法。Web 组件会排除画面黑边，正确映射坐标；按键失焦、页面隐藏或断开连接时释放。键码、滚轮与按钮在原版电脑端的实际语义仍需联调。

## 已执行验证

- 正式 API：设备初始化与二维码生成成功；未执行账号确认登录或控制真实电脑。
- 单元测试：签名、Protobuf、ACK、SOAC、ICE、坐标、连接状态及取消／清理行为。
- 本机 Chrome：页面与手机布局、设置保存、设备切换／离线提示；真实 WebRTC 回环接收并解码视频，控制通道收到二进制键盘事件。

回环测试只证明浏览器组件可协商并接收标准 WebRTC、发送数据，不证明已经兼容 UU 原生端。最终验证必须使用用户自己的扫码授权、在线原版电脑以及真实房间信令。
