import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { unzipSync } from "fflate";
import { getBinary, resolveApiKey } from "@/lib/opendart/client";
import { formatApiError } from "@/lib/opendart/errors";

// 공시서류 원본(본문 + 첨부서류)을 텍스트로 읽는 도구
// OpenDART "공시서류원본파일" API (document.xml) 사용

interface DocFile {
  name: string;
  title: string;
  text: string;
}

const cache = new Map<string, { at: number; files: DocFile[] }>();
const CACHE_TTL = 30 * 60 * 1000;

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

function xmlToText(xml: string): { title: string; text: string } {
  const titleMatch = xml.match(/<DOCUMENT-NAME[^>]*>([\s\S]*?)<\/DOCUMENT-NAME>/i);
  const title = titleMatch ? decodeEntities(titleMatch[1].replace(/<[^>]+>/g, "")).trim() : "";

  let s = xml
    .replace(/<\?xml[\s\S]*?\?>/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(IMAGE|IMG|LIBRARY)[^>]*>[\s\S]*?<\/\1>/gi, "[이미지]")
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
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { title, text: s };
}

async function loadDocument(rceptNo: string, apiKey: string): Promise<DocFile[]> {
  const hit = cache.get(rceptNo);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.files;

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
  for (const [name, bytes] of Object.entries(entries)) {
    if (!/\.(xml|htm|html)$/i.test(name)) continue;
    const { title, text } = xmlToText(decodeBytes(bytes));
    files.push({ name, title, text });
  }
  // 본문(파일명이 접수번호와 같은 것)을 맨 앞으로
  files.sort((a, b) => {
    const am = a.name.startsWith(rceptNo + ".") ? 0 : 1;
    const bm = b.name.startsWith(rceptNo + ".") ? 0 : 1;
    return am - bm || a.name.localeCompare(b.name);
  });

  cache.set(rceptNo, { at: Date.now(), files });
  return files;
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
  - keyword given → returns every matching passage (with surrounding context) across all files. Best for checking specific terms like "구속력", "위약금", "배타적".
  - no keyword → returns the file list and the text of one file (file_index, default 0 = main body), paged by offset/max_chars.
Note: scanned image-only PDFs inside a filing cannot be read as text.`,
      inputSchema: {
        rcept_no: z.string().regex(/^\d{14}$/).describe("14-digit receipt number (접수번호)"),
        keyword: z.string().optional().describe("Optional: search term(s). Separate several with '|', e.g. '구속력|위약금'"),
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
        const files = await loadDocument(params.rcept_no, key);
        if (files.length === 0) {
          return { content: [{ type: "text" as const, text: `원문 파일이 없습니다 (rcept_no: ${params.rcept_no})` }] };
        }

        const viewer = `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${params.rcept_no}`;
        const fileList = files
          .map((f, i) => `- [${i}] ${f.title || "(제목 없음)"} — ${f.name} (${f.text.length.toLocaleString()}자)`)
          .join("\n");

        // 키워드 검색 모드
        if (params.keyword) {
          const terms = params.keyword.split("|").map((t) => t.trim()).filter(Boolean);
          const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
          const re = new RegExp(esc.join("|"), "g");
          const out: string[] = [];
          let total = 0;
          files.forEach((f, i) => {
            for (const m of f.text.matchAll(re)) {
              if (total >= 30) break;
              const start = Math.max(0, (m.index ?? 0) - 300);
              const end = Math.min(f.text.length, (m.index ?? 0) + m[0].length + 300);
              out.push(`### [${i}] ${f.title || f.name} — "${m[0]}" (위치 ${m.index})\n…${f.text.slice(start, end)}…`);
              total++;
            }
          });
          const header = `## 공시 원문 키워드 검색 — ${params.rcept_no}\n원문: ${viewer}\n\n### 파일 목록\n${fileList}\n\n### 검색어: ${terms.join(", ")} → ${total}건${total >= 30 ? " (최대 30건까지만 표시)" : ""}\n`;
          return { content: [{ type: "text" as const, text: header + "\n" + (out.join("\n\n") || "일치하는 문구가 없습니다.") }] };
        }

        // 전문 읽기 모드
        const idx = Math.min(params.file_index, files.length - 1);
        const f = files[idx];
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
