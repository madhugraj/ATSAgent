/**
 * Silent panel agents, S0 (docs/silent-panel-agent-plan.md): the meeting
 * reference read from a join link, and the WebVTT transcripts the providers
 * return. Run: bun test scripts/meeting-transcripts.test.ts
 */
import { describe, expect, test } from "bun:test";

import { meetingRefOf } from "../src/lib/meeting-ref";
import { parseVtt } from "../src/lib/vtt";

describe("meetingRefOf", () => {
  test("Zoom: the numeric meeting id, from any zoom host and path form", () => {
    expect(meetingRefOf("https://us05web.zoom.us/j/81234567890?pwd=abc")).toEqual({
      meetingProvider: "zoom",
      meetingExternalId: "81234567890",
    });
    expect(meetingRefOf("https://zoom.us/w/912345678")?.meetingExternalId).toBe("912345678");
    expect(meetingRefOf("https://acme.zoomgov.com/j/1612345678")?.meetingProvider).toBe("zoom");
  });

  test("Meet: the meeting code, lower-cased", () => {
    expect(meetingRefOf("https://meet.google.com/ABC-defg-hij?authuser=0")).toEqual({
      meetingProvider: "google_meet",
      meetingExternalId: "abc-defg-hij",
    });
  });

  test("Teams: the join link itself, both link forms", () => {
    const legacy =
      "https://teams.microsoft.com/l/meetup-join/19%3ameeting_abc%40thread.v2/0?context=%7b%7d";
    expect(meetingRefOf(` ${legacy} `)).toEqual({
      meetingProvider: "teams",
      meetingExternalId: legacy,
    });
    expect(meetingRefOf("https://teams.microsoft.com/meet/3456789?p=xyz")?.meetingProvider).toBe(
      "teams",
    );
  });

  test("anything else is not a meeting we can read back", () => {
    for (const link of [
      null,
      "",
      "not a url",
      "https://zoom.us/profile",
      "https://zoom.us.evil.example/j/81234567890",
      "https://evilzoom.us/j/81234567890",
      "https://meet.google.com/landing",
      "https://teams.microsoft.com.evil.example/l/meetup-join/x",
      "https://teams.microsoft.com/v2/",
      "javascript:alert(1)",
      "https://webex.com/meet/someone",
    ])
      expect(meetingRefOf(link)).toBeNull();
  });
});

describe("parseVtt", () => {
  test("Zoom cues: numbered, `Name: text`; same speaker merged", () => {
    const vtt = [
      "WEBVTT",
      "",
      "1",
      "00:00:01.000 --> 00:00:04.500",
      "Priya Raman: Tell me about the last model you shipped.",
      "",
      "2",
      "00:00:05.000 --> 00:00:09.000",
      "Arun K: It was a ranking model for search.",
      "",
      "3",
      "00:00:09.200 --> 00:00:12.000",
      "Arun K: We cut latency by forty percent.",
    ].join("\n");
    expect(parseVtt(vtt)).toEqual([
      {
        speaker: "Priya Raman",
        text: "Tell me about the last model you shipped.",
        startMs: 1000,
        endMs: 4500,
      },
      {
        speaker: "Arun K",
        text: "It was a ranking model for search. We cut latency by forty percent.",
        startMs: 5000,
        endMs: 12000,
      },
    ]);
  });

  test("Teams cues: `<v Name>text</v>`, CRLF, hours", () => {
    const vtt =
      "WEBVTT\r\n\r\nab12/1-0\r\n01:02:03.040 --> 01:02:05.000\r\n<v Saranya R>Any questions for us?</v>\r\n";
    expect(parseVtt(vtt)).toEqual([
      { speaker: "Saranya R", text: "Any questions for us?", startMs: 3723040, endMs: 3725000 },
    ]);
  });

  test("a cue with no speaker keeps the text; markup and empty cues are dropped", () => {
    const vtt =
      "WEBVTT\n\n00:01.000 --> 00:02.000\n<i>hello</i> there\n\n00:03.000 --> 00:04.000\n<b></b>";
    expect(parseVtt(vtt)).toEqual([
      { speaker: null, text: "hello there", startMs: 1000, endMs: 2000 },
    ]);
  });
});
