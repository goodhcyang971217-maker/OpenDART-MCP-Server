import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { setSessionApiKey, getSessionApiKey } from "@/lib/opendart/client";
import { registerCompanyTools } from "./company";
import { registerFinancialTools } from "./financial";
import { registerDisclosureTools } from "./disclosure";
import { registerShareholdingTools } from "./shareholding";
import { registerMajorEventTools } from "./major-events";
import { registerSecuritiesRegTools } from "./securities-reg";
import { registerWorkflowTools } from "./workflows";
import { registerDocumentTools } from "./document";
function registerConfigTools(server: McpServer) {
  server.tool(
    "set_api_key",
    "Set your OpenDART API key for this session. Get one free at https://opendart.fss.or.kr/ — once set, all tools will use it automatically. / OpenDART API 키를 설정합니다. https://opendart.fss.or.kr/ 에서 무료 발급 후 입력하세요.",
    { api_key: z.string().describe("Your OpenDART API key / OpenDART API 인증키") },
    async ({ api_key }) => {
      setSessionApiKey(api_key);
      return {
        content: [
          {
            type: "text" as const,
            text: "API key set successfully. All tools will now use this key. / API 키가 설정되었습니다. 이제 모든 도구에서 이 키를 사용합니다.",
          },
        ],
      };
    }
  );

  server.tool(
    "get_api_key_status",
    "Check whether an OpenDART API key is configured. / OpenDART API 키 설정 여부를 확인합니다.",
    {},
    async () => {
      const hasSession = !!getSessionApiKey();
      const hasEnv = !!process.env.OPENDART_API_KEY;

      let status: string;
      if (hasSession) {
        status = "Session API key is set (via set_api_key). / 세션 API 키가 설정되어 있습니다.";
      } else if (hasEnv) {
        status = "Server API key is configured (environment variable). / 서버 API 키가 설정되어 있습니다.";
      } else {
        status =
          "No API key configured. Call set_api_key with your key first. " +
          "Get one free at https://opendart.fss.or.kr/ / " +
          "API 키가 설정되지 않았습니다. set_api_key 도구를 먼저 호출하세요. " +
          "https://opendart.fss.or.kr/ 에서 무료로 발급받을 수 있습니다.";
      }

      return { content: [{ type: "text" as const, text: status }] };
    }
  );
}

export function registerAllTools(server: McpServer) {
  registerConfigTools(server);         // API key configuration (first)
  registerWorkflowTools(server);       // Workflow tools (most useful)
  registerCompanyTools(server);        // Company search & info
  registerFinancialTools(server);      // Financial statements & indicators
  registerDisclosureTools(server);     // Periodic report details
  registerShareholdingTools(server);   // Shareholding disclosures
  registerMajorEventTools(server);     // Major corporate events
  registerSecuritiesRegTools(server);  // Securities registration statements
  registerDocumentTools(server);

}
