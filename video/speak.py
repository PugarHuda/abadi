"""Speak one scene and report where every word landed.

The edge-tts CLI's --write-subtitles groups its cues by sentence, which is useless for
captions: a twenty-word sentence becomes one card that sits on screen for nine seconds.
The synthesiser itself emits a WordBoundary event per word, so take the stream directly
and keep the offsets. They are the voice's real timings, not an alignment guess.

    python video/speak.py <text> <voice> <rate> <out.mp3> <out.json>
"""
import asyncio
import json
import sys

import edge_tts

# edge-tts reports offsets in 100-nanosecond ticks, the way SSML does.
TICKS_PER_SECOND = 10_000_000


async def main() -> None:
    text, voice, rate, mp3_path, json_path = sys.argv[1:6]
    words = []
    with open(mp3_path, "wb") as audio:
        # 7.x defaults to boundary="SentenceBoundary" — the whole point here is per word.
        speech = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary")
        async for chunk in speech.stream():
            if chunk["type"] == "audio":
                audio.write(chunk["data"])
            elif chunk["type"] == "WordBoundary":
                words.append(
                    {
                        "word": chunk["text"],
                        "start": chunk["offset"] / TICKS_PER_SECOND,
                        "end": (chunk["offset"] + chunk["duration"]) / TICKS_PER_SECOND,
                    }
                )
    with open(json_path, "w", encoding="utf-8") as meta:
        json.dump(words, meta, ensure_ascii=False)


asyncio.run(main())
