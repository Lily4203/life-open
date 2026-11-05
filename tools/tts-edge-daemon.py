# -*- coding: utf-8 -*-
"""常驻的 edge-tts 合成进程。
============================================================
为什么要有它：edge_tts 这个包 import 一次要 1.8 秒（它拖进来 aiohttp 一整坨），
python 本体启动又要 0.6 秒。每说一句都付这 2.4 秒，直播里就是"字幕三句了，声音还没出第一句"。

所以启动一次，之后一行一行吃活：
  stdin   {"id":"...","text":"...","voice":"...","rate":"+6%","pitch":"+2Hz","volume":"+0%","out":"..."}
  stdout  {"ready":true}                       启动好了
          {"id":"...","ok":true,"ms":1234,"bytes":5678}
          {"id":"...","ok":false,"error":"..."}

**产出是 mp3，不是 wav。** 这件事踩过一次：edge 的接口固定回
audio-24khz-48kbitrate-mono-mp3（库源码里写死的 outputFormat），
把它当裸 PCM 套一个 wav 头，听起来就是一串噪声——而且 RIFF 头是对的，
所以"校验通过、播放炸掉"，最难查的那一类。这台机器上又没有 ffmpeg 可转，
所以不转：mp3 交给浏览器的 decodeAudioData，它本来就认。

四条纪律：
  ① **一行一个请求，一行一个回答**，不许攒批。攒批就等于延迟不可控。
  ② **串行**：一句合成完才接下一句。并发合成只会抢带宽，不会更快，
     而且真到"她被打断"的时候，排队的那些本来就不该继续烧钱。
  ③ 出错只说一句人话，不把 aiohttp 的堆栈甩上去（那东西对用户没有信息量）。
  ④ **空闲不管**：谁能开谁负责关。node 那边空闲十分钟会把进程杀掉，
     在这里做超时只会多一条"自己死了"的路径。
"""
import asyncio
import io
import json
import os
import sys
import time

try:
    import edge_tts
except Exception as e:  # pragma: no cover - 只在没装时走到
    sys.stdout.write(json.dumps({"ok": False, "fatal": "import_failed", "error": str(e)},
                               ensure_ascii=False) + "\n")
    sys.stdout.flush()
    sys.exit(2)

DEFAULT_VOICE = os.environ.get("EDGE_VOICE", "zh-CN-XiaoyiNeural")


def say_line(obj):
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def looks_like_mp3(data):
    """头两字节是帧同步（0xFF 0xE0 掩码）或者 ID3 标签，就算它是 mp3。

    为什么要查：接口偶尔回一段 JSON 错误或者空流，字节数也可能过千。
    不查的话，那段东西会被当成音频存下来、缓存住，然后这句话永远是"嘶——"。
    """
    if len(data) < 512:
        return False
    if data[:3] == b"ID3":
        return True
    return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0


async def synth_one(req):
    """合成一句，写成 mp3。返回 (ok, 信息)。"""
    text = str(req.get("text") or "").strip()
    out = str(req.get("out") or "")
    if not text:
        return False, "空文本"
    if not out:
        return False, "没给输出路径"

    voice = str(req.get("voice") or DEFAULT_VOICE)
    kw = {}
    for key in ("rate", "pitch", "volume"):
        v = req.get(key)
        if v:
            kw[key] = str(v)

    buf = io.BytesIO()
    try:
        com = edge_tts.Communicate(text, voice, **kw)
        async for chunk in com.stream():
            if chunk.get("type") == "audio" and chunk.get("data"):
                buf.write(chunk["data"])
    except Exception as e:
        return False, "%s: %s" % (type(e).__name__, e)

    data = buf.getvalue()
    if not looks_like_mp3(data):
        return False, "回来的不是音频（%d 字节，头是 %s）" % (
            len(data), data[:4].hex() if data else "空")

    try:
        with open(out, "wb") as f:
            f.write(data)
    except Exception as e:
        return False, "写文件失败: %s" % e
    return True, os.path.getsize(out)


def main():
    say_line({"ready": True, "pid": os.getpid(), "voice": DEFAULT_VOICE})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception:
            say_line({"ok": False, "id": None, "error": "不是 JSON"})
            continue

        rid = req.get("id")
        t0 = time.time()
        try:
            ok, info = asyncio.run(synth_one(req))
        except Exception as e:  # asyncio 自己炸了也要回一句，不能让 node 等死
            ok, info = False, "事件循环出错: %s" % e
        ms = int((time.time() - t0) * 1000)
        if ok:
            say_line({"id": rid, "ok": True, "ms": ms, "bytes": info})
        else:
            say_line({"id": rid, "ok": False, "ms": ms, "error": info})


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
