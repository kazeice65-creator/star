import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;

// ===== Lark 配置 =====
const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;

// 国际版 Lark 用 https://open.larksuite.com
// 中国飞书用 https://open.feishu.cn
const LARK_OPEN_BASE_URL =
  process.env.LARK_OPEN_BASE_URL || "https://open.larksuite.com";

// ===== Hermes 配置 =====
// 推荐填法：
// HERMES_API_URL=https://你的Hermes服务域名.up.railway.app/v1
// HERMES_API_KEY=你在 Hermes Service 里设置的 API_SERVER_KEY
const HERMES_API_URL = process.env.HERMES_API_URL;
const HERMES_API_KEY = process.env.HERMES_API_KEY;
const HERMES_MODEL =
  process.env.HERMES_MODEL ||
  process.env.API_SERVER_MODEL_NAME ||
  "hermes-agent";

let cachedTenantToken = null;
let cachedTenantTokenExpireAt = 0;

const processedEvents = new Set();

// ===== 健康检查 =====
app.get("/", (req, res) => {
  res.send("Lark Hermes Agent server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "lark-hermes-agent"
  });
});

// ===== Lark 事件入口 =====
app.post("/lark/events", async (req, res) => {
  const body = req.body;

  console.log("Received Lark event:", JSON.stringify(body));

  // 1. Lark / 飞书 Request URL 校验
  if (body.challenge) {
    const token = body?.token || body?.header?.token;

    if (
      LARK_VERIFICATION_TOKEN &&
      token &&
      token !== LARK_VERIFICATION_TOKEN
    ) {
      console.error("Invalid Lark verification token during challenge.");
      return res.status(401).send("Invalid verification token");
    }

    return res.json({
      challenge: body.challenge
    });
  }

  // 2. 校验 Lark 来源
  const token = body?.header?.token || body?.token;

  if (
    LARK_VERIFICATION_TOKEN &&
    token &&
    token !== LARK_VERIFICATION_TOKEN
  ) {
    console.error("Invalid Lark verification token.");
    return res.status(401).send("Invalid token");
  }

  // 3. 必须快速返回 200，避免 Lark 超时
  res.status(200).json({ ok: true });

  // 4. 后台异步处理消息
  handleLarkEvent(body).catch((err) => {
    console.error("handleLarkEvent error:", err);
  });
});

// ===== 处理 Lark 消息事件 =====
async function handleLarkEvent(body) {
  const eventType = body?.header?.event_type;
  const eventId = body?.header?.event_id;

  // 防止 Lark 重试导致重复回复
  if (eventId) {
    if (processedEvents.has(eventId)) {
      console.log("Duplicate event ignored:", eventId);
      return;
    }

    processedEvents.add(eventId);

    if (processedEvents.size > 1000) {
      processedEvents.clear();
    }
  }

  // 只处理收到消息事件
  if (eventType !== "im.message.receive_v1") {
    console.log("Ignored event type:", eventType);
    return;
  }

  const message = body?.event?.message;

  if (!message) {
    console.log("No message found in event.");
    return;
  }

  const chatId = message.chat_id;
  const messageType = message.message_type;

  if (!chatId) {
    console.error("Missing chat_id.");
    return;
  }

  if (messageType !== "text") {
    await sendLarkMessage(
      chatId,
      "我目前先支持文字消息，图片、文件和语音后面可以继续加。"
    );
    return;
  }

  let userText = "";

  try {
    const content = JSON.parse(message.content || "{}");
    userText = content.text || "";
  } catch (err) {
    console.error("Failed to parse message content:", err);
  }

  userText = cleanLarkText(userText);

  if (!userText.trim()) {
    console.log("Empty user text.");
    return;
  }

  console.log("User text:", userText);

  const reply = await callHermes(userText, {
    chatId,
    messageId: message.message_id,
    sender: body?.event?.sender
  });

  await sendLarkMessage(chatId, reply);
}

// ===== 清理 Lark 消息文本 =====
function cleanLarkText(text) {
  if (!text) return "";

  return text
    // 去掉 Lark @ 机器人的标签
    .replace(/<at[^>]*>.*?<\/at>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ===== 调用 Hermes Agent =====
async function callHermes(userText, context = {}) {
  // 如果没填 HERMES_API_URL，进入测试模式
  if (!HERMES_API_URL) {
    return `Hermes 测试回复：我收到了你的消息：「${userText}」`;
  }

  try {
    const chatCompletionsUrl = buildHermesChatCompletionsUrl(HERMES_API_URL);

    console.log("Calling Hermes URL:", chatCompletionsUrl);
    console.log("Using Hermes model:", HERMES_MODEL);

    const headers = {
      "Content-Type": "application/json"
    };

    if (HERMES_API_KEY) {
      headers.Authorization = `Bearer ${HERMES_API_KEY}`;
    }

    const payload = {
      model: HERMES_MODEL,
      messages: [
        {
          role: "system",
          content:
            "你是部署在 Lark 企业中的 Hermes AI Agent。请用中文回复，表达清晰，尽量简洁。如果用户问部署、代码、报错，请一步一步说明。"
        },
        {
          role: "user",
          content: userText
        }
      ],
      temperature: 0.7
    };

    console.log("Hermes payload:", JSON.stringify(payload));

    const response = await fetch(chatCompletionsUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(payload)
    });

    const text = await response.text();

    if (!response.ok) {
      console.error("Hermes API status:", response.status);
      console.error("Hermes API error body:", text);
      return `Hermes API error: ${text}`;
    }

    let data;

    try {
      data = JSON.parse(text);
    } catch (err) {
      console.error("Hermes response is not JSON:", text);
      return "Hermes 返回内容不是 JSON，请检查 HERMES_API_URL 是否填对。";
    }

    console.log("Hermes response:", JSON.stringify(data));

    const reply =
      data?.choices?.[0]?.message?.content ||
      data?.choices?.[0]?.text ||
      data?.reply ||
      data?.message ||
      data?.output ||
      data?.text;

    if (!reply) {
      console.error("Hermes response missing reply:", JSON.stringify(data));
      return "Hermes 已返回，但没有找到可显示的回复内容。请查看 Railway 日志。";
    }

    return String(reply);
  } catch (err) {
    console.error("callHermes error:", err);
    return "连接 Hermes 失败，请检查 HERMES_API_URL 是否是正确的公网地址。";
  }
}

// ===== 拼接 Hermes chat completions 地址 =====
function buildHermesChatCompletionsUrl(rawUrl) {
  let url = rawUrl.trim().replace(/\/+$/, "");

  // 如果你误填成完整接口，也兼容
  if (url.endsWith("/chat/completions")) {
    return url;
  }

  // 推荐填到 /v1，这里自动补 /chat/completions
  return `${url}/chat/completions`;
}

// ===== 获取 Lark tenant_access_token =====
async function getTenantAccessToken() {
  const now = Date.now();

  if (cachedTenantToken && now < cachedTenantTokenExpireAt) {
    return cachedTenantToken;
  }

  if (!LARK_APP_ID || !LARK_APP_SECRET) {
    throw new Error("Missing LARK_APP_ID or LARK_APP_SECRET");
  }

  const response = await fetch(
    `${LARK_OPEN_BASE_URL}/open-apis/auth/v3/tenant_access_token/internal`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        app_id: LARK_APP_ID,
        app_secret: LARK_APP_SECRET
      })
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.error("getTenantAccessToken failed:", JSON.stringify(data));
    throw new Error("Failed to get tenant_access_token");
  }

  cachedTenantToken = data.tenant_access_token;

  // token 通常 2 小时有效，这里提前刷新
  cachedTenantTokenExpireAt = now + 100 * 60 * 1000;

  return cachedTenantToken;
}

// ===== 给 Lark 群/私聊发送消息 =====
async function sendLarkMessage(chatId, text) {
  try {
    const token = await getTenantAccessToken();

    const safeText = String(text || "Hermes 没有返回内容。");

    const response = await fetch(
      `${LARK_OPEN_BASE_URL}/open-apis/im/v1/messages?receive_id_type=chat_id`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          receive_id: chatId,
          msg_type: "text",
          content: JSON.stringify({
            text: safeText
          })
        })
      }
    );

    const data = await response.json();

    if (data.code !== 0) {
      console.error("sendLarkMessage failed:", JSON.stringify(data));
    }

    return data;
  } catch (err) {
    console.error("sendLarkMessage error:", err);
  }
}

// ===== 启动服务 =====
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
