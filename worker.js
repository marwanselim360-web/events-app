export default {
  async fetch(request, env) {
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    const BOT_TOKEN = "8921464117:AAE-EDpZ09tXc0hiCInYr3bN9s8ZLkr8p_w";
    const DEFAULT_CHAT = "-1003837109142";
    const url = new URL(request.url);
    const kv = env.GALLERY_KV || env.EVENTS_KV;

    // 1. Proxy Stream & Download
    if (url.searchParams.has("file_id") && !url.searchParams.has("action")) {
      const fId = url.searchParams.get("file_id");
      const isDl = url.searchParams.get("dl") === "1";

      try {
        const fileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fId}`);
        const fileData = await fileRes.json();
        if (fileData.ok && fileData.result.file_path) {
          const filePath = fileData.result.file_path;
          const tgMediaUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

          const forwardHeaders = new Headers();
          if (request.headers.has("range")) forwardHeaders.set("range", request.headers.get("range"));

          const mediaRes = await fetch(tgMediaUrl, { headers: forwardHeaders });
          const responseHeaders = new Headers(mediaRes.headers);
          responseHeaders.set("Access-Control-Allow-Origin", "*");
          responseHeaders.set("Accept-Ranges", "bytes");
          responseHeaders.set("Cache-Control", "public, max-age=86400");

          let ext = filePath.split('.').pop().toLowerCase();
          if (ext === "mp4") responseHeaders.set("Content-Type", "video/mp4");
          else if (ext === "oga" || ext === "ogg") responseHeaders.set("Content-Type", "audio/ogg");
          else if (ext === "m4a") responseHeaders.set("Content-Type", "audio/mp4");
          else if (ext === "jpg" || ext === "jpeg") responseHeaders.set("Content-Type", "image/jpeg");

          if (isDl) responseHeaders.set("Content-Disposition", `attachment; filename="memory_${Date.now()}.${ext}"`);

          return new Response(mediaRes.body, { status: mediaRes.status, headers: responseHeaders });
        }
      } catch (e) {}
      return new Response("Media not found", { status: 404, headers: corsHeaders });
    }

    // 2. GET Gallery Feed
    if (request.method === "GET") {
      const chatId = (url.searchParams.get("chat_id") || DEFAULT_CHAT).trim();
      const eventSlug = (url.searchParams.get("event") || url.searchParams.get("e") || "default_event").trim();
      const key = `event_${chatId}_${eventSlug}`;
      
      let allMedia = [];
      let kvStatus = kv ? "bound" : "not_bound";
      let kvError = null;

      if (kv) {
        try {
          const raw = await kv.get(key);
          if (raw) {
            allMedia = JSON.parse(raw);
          }
        } catch (e) {
          kvError = e.message;
        }
      }

      const workerBase = `${url.protocol}//${url.host}`;
      allMedia = allMedia.map(item => ({
        ...item,
        url: `${workerBase}/?file_id=${item.file_id}`
      }));

      return new Response(JSON.stringify({
        ok: true,
        key_used: key,
        kv_status: kvStatus,
        kv_error: kvError,
        media: allMedia
      }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" }
      });
    }

    // 3. POST Upload or Delete
    if (request.method === "POST") {
      try {
        if (url.searchParams.get("action") === "delete") {
          const body = await request.json();
          const chatId = (body.chat_id || DEFAULT_CHAT).trim();
          const eventSlug = (body.event || "default_event").trim();
          const fileId = body.file_id;
          const messageId = body.message_id;
          const key = `event_${chatId}_${eventSlug}`;

          if (messageId) {
            try {
              await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/deleteMessage`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ chat_id: chatId, message_id: messageId })
              });
            } catch (e) {}
          }

          if (kv && fileId) {
            try {
              const existingRaw = await kv.get(key);
              if (existingRaw) {
                let list = JSON.parse(existingRaw);
                if (Array.isArray(list)) {
                  list = list.filter(item => item.file_id !== fileId);
                  await kv.put(key, JSON.stringify(list));
                }
              }
            } catch (e) {}
          }

          return new Response(JSON.stringify({ ok: true }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const formData = await request.formData();
        const file = formData.get("file");
        const chatId = (formData.get("chat_id") || DEFAULT_CHAT).trim();
        const eventSlug = (formData.get("event") || formData.get("e") || "default_event").trim();
        const mediaType = formData.get("type") || "photo";
        const key = `event_${chatId}_${eventSlug}`;

        if (!file) {
          return new Response(JSON.stringify({ ok: false, error: "No file provided" }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 400
          });
        }

        const threadKey = `thread_${chatId}_${eventSlug}`;
        let messageThreadId = null;

        if (kv) {
          try {
            messageThreadId = await kv.get(threadKey);
          } catch (e) {}
        }

        if (!messageThreadId && kv) {
          try {
            const createRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, name: eventSlug })
            });
            const createData = await createRes.json();
            if (createData.ok && createData.result.message_thread_id) {
              messageThreadId = createData.result.message_thread_id;
              await kv.put(threadKey, messageThreadId.toString());
            }
          } catch (err) {}
        }

        const tgFormData = new FormData();
        tgFormData.append("chat_id", chatId);
        
        if (messageThreadId) {
          tgFormData.append("message_thread_id", messageThreadId);
        }

        let endpoint = "sendPhoto";
        if (mediaType === "video" || mediaType === "videowish") {
          endpoint = "sendVideo";
          tgFormData.append("video", file, file.name || "video.mp4");
        } else if (mediaType === "voice") {
          endpoint = "sendVoice";
          tgFormData.append("voice", file, file.name || "voice.m4a");
        } else {
          endpoint = "sendPhoto";
          tgFormData.append("photo", file, file.name || "photo.jpg");
        }

        let tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
          method: "POST",
          body: tgFormData
        });

        let tgData = await tgRes.json();

        if (!tgData.ok && tgData.description && tgData.description.includes("thread")) {
          try {
            const createTopicRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createForumTopic`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ chat_id: chatId, name: eventSlug })
            });
            const topicData = await createTopicRes.json();
            if (topicData.ok && topicData.result.message_thread_id) {
              messageThreadId = topicData.result.message_thread_id;
              if (kv) await kv.put(threadKey, messageThreadId.toString());

              tgFormData.set("message_thread_id", messageThreadId);
              tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${endpoint}`, {
                method: "POST",
                body: tgFormData
              });
              tgData = await tgRes.json();
            }
          } catch (err) {}
        }

        if (!tgData.ok) {
          return new Response(JSON.stringify({ ok: false, error: tgData.description }), {
            headers: { ...corsHeaders, "Content-Type": "application/json" },
            status: 200
          });
        }

        let fileId = "";
        if (tgData.result.photo) fileId = tgData.result.photo[tgData.result.photo.length - 1].file_id;
        else if (tgData.result.video) fileId = tgData.result.video.file_id;
        else if (tgData.result.voice) fileId = tgData.result.voice.file_id;
        else if (tgData.result.document) fileId = tgData.result.document.file_id;

        const messageId = tgData.result.message_id;
        const workerBase = `${url.protocol}//${url.host}`;
        const item = {
          file_id: fileId,
          message_id: messageId,
          url: `${workerBase}/?file_id=${fileId}`,
          type: mediaType,
          timestamp: Date.now()
        };

        let kvSaved = false;
        let kvWriteError = null;

        if (kv && fileId) {
          try {
            const existingRaw = await kv.get(key);
            let list = [];
            if (existingRaw) {
              try { list = JSON.parse(existingRaw); } catch(e) {}
            }
            if (!Array.isArray(list)) list = [];
            list.unshift(item);
            await kv.put(key, JSON.stringify(list));
            kvSaved = true;
          } catch (kvErr) {
            kvWriteError = kvErr.message;
          }
        }

        return new Response(JSON.stringify({
          ok: true,
          item,
          key_written: key,
          kv_saved: kvSaved,
          kv_write_error: kvWriteError
        }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });

      } catch (err) {
        return new Response(JSON.stringify({ ok: false, error: err.message }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" },
          status: 200
        });
      }
    }

    return new Response("Method not allowed", { status: 405, headers: corsHeaders });
  }
};