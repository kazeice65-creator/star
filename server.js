import express from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;

const LARK_APP_ID = process.env.LARK_APP_ID;
const LARK_APP_SECRET = process.env.LARK_APP_SECRET;
const LARK_VERIFICATION_TOKEN = process.env.LARK_VERIFICATION_TOKEN;

// 国际版 Lark 用这个
// 中国飞书用户后面可以改成 https://open.feishu.cn
const LARK_OPEN_BASE_URL =
  process.env.LARK_OPEN_BASE_URL || "https://open.larksuite.com";

const HERMES_API_URL = process.env.HERMES_API_URL;
const HERMES_API_KEY = process.env.HERMES_API_KEY;

let cachedTenantToken = null;
let cachedTenantTokenExpireAt = 0;

app.get("/", (req, res) => {
  res.send("Hermes Agent server is running.");
});

app.get("/health", (req, res) => {
  res.json({ ok: true });
});

app.post("/lark/events", async (req, res) => {
  const body = req.body;

  // Lark 第一次验证服务器地址时，会发送 challenge
  if (body.challenge) {
    if (body.token && body.token !== LARK_VERIFICATION_TOKEN) {
      return res.status(401).send("Invalid verification token");
    }

    return res.json({
      challenge: body.challenge
    });
  }

  // 验证是不是 Lark 发来的消息
  const token = body?.header?.token || body?.token;

  if (LARK_VERIFICATION_TOKEN && token !== LARK_VERIFICATION_TOKEN) {
    return res.status(401).send("Invalid token");
  }

  // 先快速告诉 Lark：我收到了
  res.status(200).json({ ok: true });

  // 再慢慢处理消息
  handleLarkEvent(body).catch((err) => {
    console.error("handleLarkEvent error:", err);
  });
});

async function handleLarkEvent(body) {
  const eventType = body?.header?.event_type;

  // 只处理“收到消息”这个事件
  if (eventType !== "im.message.receive_v1") {
    return;
  }

  const message = body?.event?.message;
  if (!message) return;

  const chatId = message.chat_id;
  const messageType = message.message_type;

  if (messageType !== "text") {
    await sendLarkMessage(chatId, "我现在先支持文字消息，图片和文件后面再加。");
    return;
  }

  let userText = "";

  try {
    const content = JSON.parse(message.content || "{}");
    userText = content.text || "";
  } catch (err) {
    console.error("parse message content error:", err);
  }

  if (!userText.trim()) {
    return;
  }

  const reply = await callHermes(userText, {
    chatId,
    messageId: message.message_id
  });

  await sendLarkMessage(chatId, reply);
}

async function callHermes(userText, context = {}) {
  // 如果你已经有 Hermes Agent API，就会走这里
  if (HERMES_API_URL) {
    try {
      const response = await fetch(HERMES_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(HERMES_API_KEY
            ? { Authorization: `Bearer ${HERMES_API_KEY}` }
            : {})
        },
        body: JSON.stringify({
          message: userText,
          context
        })
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Hermes API error:", errorText);
        return "Hermes Agent 调用失败，请检查 Railway 日志。";
      }

      const data = await response.json();

      return (
        data.reply ||
        data.message ||
        data.output ||
        data.text ||
        "Hermes Agent 已返回，但我没有找到可显示的文字。"
      );
    } catch (err) {
      console.error("callHermes error:", err);
      return "连接 Hermes Agent 失败，请检查 HERMES_API_URL。";
    }
  }

  // 如果你还没有 Hermes API，就先用这个测试 Lark 是否跑通
  return `Hermes 测试回复：我收到了你的消息：「${userText}」`;
}

async function getTenantAccessToken() {
  const now = Date.now();

  if (cachedTenantToken && now < cachedTenantTokenExpireAt) {
    return cachedTenantToken;
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
    console.error("getTenantAccessToken failed:", data);
    throw new Error("Failed to get tenant_access_token");
  }

  cachedTenantToken = data.tenant_access_token;

  // 提前过期，避免临界时间失效
  cachedTenantTokenExpireAt = now + 100 * 60 * 1000;

  return cachedTenantToken;
}

async function sendLarkMessage(chatId, text) {
  const token = await getTenantAccessToken();

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
          text
        })
      })
    }
  );

  const data = await response.json();

  if (data.code !== 0) {
    console.error("sendLarkMessage failed:", data);
  }

  return data;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});