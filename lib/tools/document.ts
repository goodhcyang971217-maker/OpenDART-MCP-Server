import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unzipSync } from "fflate";
import { getBinary, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";

// 공시서류 원본(본문 + 첨부서류 + 이미지)을 읽는 도구
// OpenDART "공시서류원본파일" API (document.xml) 사용

interface DocFile {
  name: string;
  title: string;
  text: string;
}

interface OtherFile {
  name: string;
  size: number;
  bytes: Uint8Array;
}

interface LoadedDoc {
  files: DocFile[];
  others: OtherFile[];
}

const cache = new Map<string, { at: number; doc: LoadedDoc }>();
const CACHE_TTL = 30 * 60 * 1000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const MIME: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  bmp: "image/bmp",
  webp: "image/webp",
};

function decodeBytes(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.slice(0, 200));
  const m = head.match(/encoding=["']([^"']+)["']/i);
  const enc = (m?.[1] || "utf-8").toLowerCase();
  try {
    return new TextDecoder(enc === "euc-kr" || enc === "ks_c_5601-1987" ? "euc-kr" : enc).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");
}

// 이미지 태그에서 파일명을 찾아 "[이미지: 파일명]"으로 표시
function imageMarker(block: string): string {
  const m = block.match(/([\w\-.]+\.(?:jpe?g|png|gif|bmp|webp))/i);
  return m ? ` [이미지: ${m[1]}] ` : " [이미지] ";
}

function xmlToText(xml: string): { title: string; text: string } {
  const titleMatch = xml.match(/<(?:DOCUMENT-NAME|TITLE)[^>]*>([\s\S]*?)<\/(?:DOCUMENT-NAME|TITLE)>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim() : "";

  let s = xml
    .replace(/[\r\n\t]+/g, " ")
    .replace(/<(STYLE|SCRIPT)[^>]*>[\s\S]*?<\/\1>/gi, "")
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(IMAGE)[^>]*>[\s\S]*?<\/\1>/gi, (b) => imageMarker(b))
    .replace(/<IMG[^>]*>[\s\S]*?<\/IMG>/gi, (b) => imageMarker(b))
    .replace(/<IMG[^>]*\/?>/gi, (b) => imageMarker(b))
    // 표: 행은 줄바꿈, 칸은 " | "
    .replace(/<\/(TD|TH|TE|TU)>/gi, " | ")
    .replace(/<TR[^>]*>/gi, "\n| ")
    .replace(/<\/TR>/gi, "")
    .replace(/<\/?TABLE[^>]*>/gi, "\n")
    // 제목·문단 구분
    .replace(/<TITLE[^>]*>/gi, "\n\n## ")
    .replace(/<\/TITLE>/gi, "\n")
    .replace(/<(P|BR|SECTION-\d|PGBRK|COVER-TITLE)[^>]*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  s = decodeEntities(s)
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

async function loadDocument(rceptNo: string, apiKey: string): Promise<LoadedDoc> {
  const hit = cache.get(rceptNo);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.doc;

  const buf = new Uint8Array(await getBinary("document", { rcept_no: rceptNo }, apiKey));

  // ZIP이 아니면 OpenDART 오류 응답(XML)
  if (!(buf[0] === 0x50 && buf[1] === 0x4b)) {
    const body = new TextDecoder("utf-8").decode(buf);
    const status = body.match(/<status>(.*?)<\/status>/)?.[1] ?? "?";
    const message = body.match(/<message>(.*?)<\/message>/)?.[1] ?? body.slice(0, 200);
    throw new Error(`[OpenDART ${status}] ${message} (rcept_no: ${rceptNo})`);
  }

  const entries = unzipSync(buf);
  const files: DocFile[] = [];
  const others: OtherFile[] = [];
  for (const [name, bytes] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    if (/\.(xml|htm|html)$/i.test(name)) {
      const { title, text } = xmlToText(decodeBytes(bytes));
      files.push({ name, title, text });
    } else {
      others.push({ name, size: bytes.length, bytes });
    }
  }
  // 본문(파일명이 접수번호와 같은 것)을 맨 앞으로
  files.sort((a, b) => {
    const am = a.name.startsWith(rceptNo + ".") ? 0 : 1;
    const bm = b.name.startsWith(rceptNo + ".") ? 0 : 1;
    return am - bm || a.name.localeCompare(b.name);
  });
  others.sort((a, b) => a.name.localeCompare(b.name));

  const doc = { files, others };
  cache.set(rceptNo, { at: Date.now(), doc });
  return doc;
}

function fileListMd(doc: LoadedDoc): string {
  const lines = doc.files.map(
    (f, i) => `- [${i}] ${f.title || "(제목 없음)"} — ${f.name} (${f.text.length.toLocaleString()}자)`
  );
  if (doc.others.length) {
    lines.push("", "#### 이미지·기타 파일 (image 파라미터에 파일명을 넣으면 그림으로 볼 수 있음)");
    for (const o of doc.others) lines.push(`- ${o.name} (${Math.ceil(o.size / 1024).toLocaleString()}KB)`);
  } else {
    lines.push("", "(압축파일 안에 이미지·기타 파일 없음)");
  }
  return lines.join("\n");
}

const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

export function registerDocumentTools(server: McpServer) {
  server.registerTool(
    "opendart_get_document",
    {
      title: "공시 원문 읽기 (Read Disclosure Document)",
      description: `Read the FULL TEXT of a DART filing (main body + attached documents) by receipt number (rcept_no, 14 digits, from opendart_search_disclosure).
Use this whenever exact wording matters (e.g. whether an MOU is binding, contract terms, conditions, legal clauses). Quote the text and cite the rcept_no.

Modes:
  - keyword given → returns matching passages (overlapping hits merged) across all files. Best for checking specific terms like "구속력", "위약금", "배타적". Use a few precise terms.
  - image given (a file name from the file list, e.g. "20260318000714_001.jpg") → returns that image so you can look at it. Use this for parts shown as [이미지: ...] in the text (scanned tables, audit opinions, seals).
  - neither → returns the file list and the text of one file (file_index, default 0 = main body), paged by offset/max_chars.`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        keyword: z.string().optional().describe("Optional: search term(s). Separate several with '|', e.g. '구속력|위약금'"),
        image: z.string().optional().describe("Optional: image file name from the file list, to view that image"),
        file_index: z.number().int().min(0).default(0).describe("Which file to read (0 = main body). See file list in output."),
        offset: z.number().int().min(0).default(0).describe("Character offset for paging long documents"),
        max_chars: z.number().int().min(1000).max(50000).default(20000).describe("Max characters to return"),
        api_key: z.string().optional().describe("Optional: your own OpenDART API key"),
      },
      annotations,
    },
    async (params) => {
      try {
        const key = resolveApiKey(params.api_key);
        const doc = await loadDocument(params.rcept_no, key);
        const viewer = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${params.rcept_no}`;
        const fileList = fileListMd(doc);

        // 이미지 보기 모드
        if (params.image) {
          const want = params.image.trim().toLowerCase();
          const img = doc.others.find((o) => o.name.toLowerCase() === want)
            ?? doc.others.find((o) => o.name.toLowerCase().endsWith(want));
          if (!img) {
            return { content: [{ type: "text" as const, text: `이미지 "${params.image}"를 찾을 수 없습니다.\n\n### 파일 목록\n${fileList}` }], isError: true };
          }
          const ext = img.name.split(".").pop()?.toLowerCase() ?? "";
          const mimeType = MIME[ext];
          if (!mimeType) {
            return { content: [{ type: "text" as const, text: `"${img.name}"은 이미지 형식이 아니라서 표시할 수 없습니다 (확장자: ${ext}).` }], isError: true };
          }
          if (img.size > MAX_IMAGE_BYTES) {
            return { content: [{ type: "text" as const, text: `"${img.name}"이 너무 큽니다 (${Math.ceil(img.size / 1024)}KB). 원문 화면에서 확인하세요: ${viewer}` }], isError: true };
          }
          let bin = "";
          for (let i = 0; i < img.bytes.length; i += 0x8000) {
            bin += String.fromCharCode(...img.bytes.subarray(i, i + 0x8000));
          }
          return {
            content: [
              { type: "text" as const, text: `## 공시 이미지 — ${params.rcept_no} / ${img.name}\n원문: ${viewer}` },
              { type: "image" as const, data: btoa(bin), mimeType },
            ],
          };
        }

        if (doc.files.length === 0) {
          return { content: [{ type: "text" as const, text: `원문 파일이 없습니다 (rcept_no: ${params.rcept_no})\n\n### 파일 목록\n${fileList}` }] };
        }

        // 키워드 검색 모드: 겹치는 구간은 하나로 합침
        if (params.keyword) {
          const terms = params.keyword.split("|").map((t) => t.trim()).filter(Boolean);
          const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          const re = new RegExp(esc.join("|"), "gi");
          const CONTEXT = 300;
          const out: string[] = [];
          let hits = 0;
          doc.files.forEach((f, i) => {
            const spans: Array<{ start: number; end: number; words: Set<string> }> = [];
            for (const m of f.text.matchAll(re)) {
              hits++;
              const pos = m.index ?? 0;
              const start = Math.max(0, pos - CONTEXT);
              const end = Math.min(f.text.length, pos + m[0].length + CONTEXT);
              const last = spans[spans.length - 1];
              if (last && start <= last.end) {
                last.end = Math.max(last.end, end);
                last.words.add(m[0]);
              } else {
                spans.push({ start, end, words: new Set([m[0]]) });
              }
            }
            for (const sp of spans) {
              if (out.length >= 15) break;
              out.push(`### [${i}] ${f.title || f.name} — ${[...sp.words].join(", ")} (위치 ${sp.start}~${sp.end})\n…${f.text.slice(sp.start, sp.end)}…`);
            }
          });
          const header = `## 공시 원문 키워드 검색 — ${params.rcept_no}\n원문: ${viewer}\n\n### 파일 목록\n${fileList}\n\n### 검색어: ${terms.join(", ")} → ${hits}회 일치, ${out.length}개 구간${out.length >= 15 ? " (최대 15개 구간까지만 표시)" : ""}\n`;
          return { content: [{ type: "text" as const, text: header + "\n" + (out.join("\n\n") || "일치하는 문구가 없습니다.") }] };
        }

        // 전문 읽기 모드
        const idx = Math.min(params.file_index, doc.files.length - 1);
        const f = doc.files[idx];
        const chunk = f.text.slice(params.offset, params.offset + params.max_chars);
        const end = params.offset + chunk.length;
        const more = end < f.text.length
          ? `\n\n---\n(계속: 전체 ${f.text.length.toLocaleString()}자 중 ${end.toLocaleString()}자까지 표시. 다음은 offset=${end})`
          : "\n\n---\n(끝)";
        const text = `## 공시 원문 — ${params.rcept_no}\n원문: ${viewer}\n\n### 파일 목록\n${fileList}\n\n### [${idx}] ${f.title || f.name}\n\n${chunk}${more}`;
        return { content: [{ type: "text" as const, text }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: formatApiError(err) }], isError: true };
      }
    }
  );
}
