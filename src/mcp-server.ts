#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";

dotenv.config();

const { CONF_BASE_URL, CONF_USERNAME, CONF_PASSWORD, CONF_SPACE, CONF_TOKEN } = process.env;

// 判断是否使用 PAT (Personal Access Token) 认证
const usePatAuth = Boolean(CONF_TOKEN);

// 创建 axios 认证配置
function getAxiosAuthConfig(): { auth?: { username: string; password: string }; headers?: Record<string, string> } {
  if (usePatAuth) {
    return {
      headers: {
        Authorization: `Bearer ${CONF_TOKEN}`,
      },
    };
  }
  return {
    auth: {
      username: CONF_USERNAME ?? "",
      password: CONF_PASSWORD ?? "",
    },
  };
}

// 创建请求头认证配置（用于 fetch 等原生请求）
function getAuthHeader(): string {
  if (usePatAuth) {
    return `Bearer ${CONF_TOKEN}`;
  }
  const token = Buffer.from(`${CONF_USERNAME}:${CONF_PASSWORD}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

// 创建 axios 实例
const authConfig = getAxiosAuthConfig();
const api = axios.create({
  baseURL: `${CONF_BASE_URL}/rest/api`,
  ...authConfig,
  headers: {
    "Content-Type": "application/json",
    ...authConfig.headers,
  },
  // 允许大内容的请求，解决更新文档内容过长时失败的问题
  maxContentLength: Infinity,
  maxBodyLength: Infinity,
});

type ConfluencePage = {
  id: string;
  title: string;
  version: { number: number };
  space: { key: string };
  body?: { storage?: { value?: string } };
  _links: { webui: string };
};

type ConfluenceSearchResult = {
  id: string;
  title: string;
  version: { number: number };
  space: { key: string };
  _links: { webui: string };
};

type ConfluenceComment = {
  id: string;
  type: "comment";
  title?: string;
  body?: { storage?: { value?: string } };
  _links?: { webui?: string };
};

// ===== Confluence API 函数 =====

async function getPage(space: string, title: string): Promise<ConfluencePage | undefined> {
  try {
    const res = await api.get<{ results: ConfluencePage[] }>("/content", {
      params: {
        spaceKey: space,
        title,
        expand: "version,space,body.storage",
      },
    });
    return res.data.results[0];
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面失败: ${message}`);
  }
}

async function getPageById(pageId: string): Promise<ConfluencePage> {
  try {
    const res = await api.get<ConfluencePage>(`/content/${pageId}`, {
      params: {
        expand: "version,space,body.storage",
      },
    });
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面失败: ${message}`);
  }
}

async function createPage(
  space: string,
  title: string,
  content: string,
  parentId: string | null = null
): Promise<ConfluencePage> {
  try {
    const pageData: Record<string, unknown> = {
      type: "page",
      title,
      space: { key: space },
      body: {
        storage: {
          value: content,
          representation: "storage",
        },
      },
    };

    if (parentId) {
      pageData.ancestors = [{ id: parentId }];
    }

    const res = await api.post<ConfluencePage>("/content", pageData);
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`创建页面失败: ${message}`);
  }
}

async function updatePage(page: ConfluencePage, content: string, title: string | null = null): Promise<ConfluencePage> {
  try {
    const res = await api.put<ConfluencePage>(`/content/${page.id}`, {
      id: page.id,
      type: "page",
      title: title || page.title,
      version: {
        number: page.version.number + 1,
      },
      body: {
        storage: {
          value: content,
          representation: "storage",
        },
      },
    });
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`更新页面失败: ${message}`);
  }
}

async function deletePage(pageId: string): Promise<{ success: true; message: string }> {
  try {
    await api.delete(`/content/${pageId}`);
    return { success: true, message: "页面已删除" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`删除页面失败: ${message}`);
  }
}

async function listAllSpaces({
  type = "global",
  limit = 200,
}: {
  type?: "global" | "personal";
  limit?: number;
} = {}): Promise<Array<{ key: string; name: string; type: string; id: string }>> {
  try {
    const res = await api.get<{ results: Array<{ key: string; name: string; type: string; id: string }> }>("/space", {
      params: { type, limit },
    });
    return res.data.results.map((s) => ({
      key: s.key,
      name: s.name,
      type: s.type,
      id: s.id,
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取 Spaces 失败: ${message}`);
  }
}

async function searchPages(space: string | undefined, query: string, limit = 25): Promise<ConfluenceSearchResult[]> {
  try {
    const cql = space ? `space=${space} AND title~"${query}"` : `title~"${query}"`;

    const res = await api.get<{ results: ConfluenceSearchResult[] }>("/content/search", {
      params: {
        cql,
        limit,
        expand: "space,version",
      },
    });
    return res.data.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`搜索页面失败: ${message}`);
  }
}

async function getChildPages(parentId: string, limit = 50): Promise<ConfluencePage[]> {
  try {
    const res = await api.get<{ results: ConfluencePage[] }>(`/content/${parentId}/child/page`, {
      params: {
        limit,
        expand: "version,space",
      },
    });
    return res.data.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取子页面失败: ${message}`);
  }
}

async function getPageHistory(pageId: string, limit = 10): Promise<unknown> {
  try {
    const res = await api.get(`/content/${pageId}/history`, {
      params: { limit },
    });
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面历史失败: ${message}`);
  }
}

async function getPageComments(pageId: string, limit = 50): Promise<ConfluenceComment[]> {
  try {
    const res = await api.get<{ results: ConfluenceComment[] }>(`/content/${pageId}/child/comment`, {
      params: {
        limit,
        expand: "body.storage,version,ancestors",
        depth: "all", // 获取所有层级的评论（包括回复）
      },
    });
    return res.data.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面评论失败: ${message}`);
  }
}

type UserCommentSearchResult = {
  id: string;
  title?: string;
  body?: { storage?: { value?: string } };
  container?: { id: string; title: string; type: string };
  space?: { key: string; name: string };
  version?: { when: string; by?: { displayName?: string; username?: string } };
  _links?: { webui?: string };
};

async function searchUserComments({
  username,
  space,
  startDate,
  endDate,
  limit = 50,
}: {
  username: string;
  space?: string;
  startDate?: string; // 格式：YYYY-MM-DD
  endDate?: string; // 格式：YYYY-MM-DD
  limit?: number;
}): Promise<UserCommentSearchResult[]> {
  try {
    // 使用 CQL 搜索用户的评论
    let cql = `type=comment AND creator="${username}"`;
    if (space) {
      cql += ` AND space="${space}"`;
    }
    if (startDate) {
      cql += ` AND created>="${startDate}"`;
    }
    if (endDate) {
      cql += ` AND created<="${endDate}"`;
    }

    const res = await api.get<{ results: UserCommentSearchResult[] }>("/content/search", {
      params: {
        cql,
        limit,
        expand: "body.storage,version,space,container",
      },
    });
    return res.data.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`搜索用户评论失败: ${message}`);
  }
}

type RestrictionType = "none" | "edit_only" | "view_only";

type PageRestrictionResult = {
  success: boolean;
  message: string;
  restrictions?: unknown;
};

async function setPageRestriction({
  pageId,
  restrictionType,
  username,
}: {
  pageId: string;
  restrictionType: RestrictionType;
  username?: string; // 用于 view_only/edit_only，默认使用当前用户
}): Promise<PageRestrictionResult> {
  const targetUser = username || CONF_USERNAME;
  if (!targetUser && restrictionType !== "none") {
    throw new Error("设置权限需要指定用户名或配置 CONF_USERNAME 环境变量");
  }

  // 创建一个使用 experimental API 的 axios 实例
  const experimentalApi = axios.create({
    baseURL: `${CONF_BASE_URL}/rest/experimental`,
    ...authConfig,
    headers: {
      "Content-Type": "application/json",
      ...authConfig.headers,
    },
  });

  try {
    if (restrictionType === "none") {
      // 删除所有限制 - 无限制
      // 先尝试删除 read 和 update 限制
      await experimentalApi.delete(`/content/${pageId}/restriction/byOperation/read/user`).catch(() => {});
      await experimentalApi.delete(`/content/${pageId}/restriction/byOperation/update/user`).catch(() => {});
      // 也尝试标准 API
      await api.delete(`/content/${pageId}/restriction`).catch(() => {});
      return { success: true, message: "已移除所有页面限制，现在页面对所有人开放" };
    }

    // 先清除现有限制
    await experimentalApi.delete(`/content/${pageId}/restriction/byOperation/read/user`).catch(() => {});
    await experimentalApi.delete(`/content/${pageId}/restriction/byOperation/update/user`).catch(() => {});

    // 构建限制数据（experimental API 格式）
    const restrictions: Array<{
      operation: string;
      restrictions: {
        user: Array<{ type: string; username: string }>;
        group: Array<{ type: string; name: string }>;
      };
    }> = [];

    if (restrictionType === "view_only") {
      // 只有自己能查看 - 设置 read 和 update 限制
      restrictions.push({
        operation: "read",
        restrictions: {
          user: [{ type: "known", username: targetUser! }],
          group: [],
        },
      });
      restrictions.push({
        operation: "update",
        restrictions: {
          user: [{ type: "known", username: targetUser! }],
          group: [],
        },
      });
    } else if (restrictionType === "edit_only") {
      // 限制编辑 - 只设置 update 限制，所有人可查看
      restrictions.push({
        operation: "update",
        restrictions: {
          user: [{ type: "known", username: targetUser! }],
          group: [],
        },
      });
    }

    // 使用 experimental API (POST) 设置限制
    const res = await experimentalApi.post(`/content/${pageId}/restriction`, restrictions);

    const messageMap: Record<RestrictionType, string> = {
      none: "已移除所有页面限制",
      edit_only: `已设置为仅 ${targetUser} 可编辑，其他人可查看`,
      view_only: `已设置为仅 ${targetUser} 可查看和编辑`,
    };

    return {
      success: true,
      message: messageMap[restrictionType],
      restrictions: res.data,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`设置页面权限失败: ${message}`);
  }
}

async function getPageRestrictions(pageId: string): Promise<unknown> {
  try {
    const res = await api.get(`/content/${pageId}/restriction`);
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面权限失败: ${message}`);
  }
}

async function addCommentToPage({
  pageId,
  commentHtml,
  parentCommentId,
}: {
  pageId: string;
  commentHtml: string;
  parentCommentId?: string;
}): Promise<ConfluenceComment> {
  try {
    // 兼容性更好的方式：直接通过 /content 创建 comment（一些 Confluence 版本对 /content/{id}/child/comment 的 POST 会返回 405）
    const payload: Record<string, unknown> = {
      type: "comment",
      title: "comment",
      container: { type: "page", id: pageId },
      body: {
        storage: {
          value: commentHtml,
          representation: "storage",
        },
      },
    };
    if (parentCommentId) {
      payload.ancestors = [{ id: parentCommentId }];
    }

    const res = await api.post<ConfluenceComment>("/content", payload);
    return res.data;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`添加评论失败: ${message}`);
  }
}

// ===== 附件上传 =====

type UploadAttachmentResult = {
  id?: string;
  title?: string;
  mediaType?: string;
  download?: string;
  webui?: string;
};

async function uploadAttachmentToPage({
  pageId,
  fileName,
  fileArrayBuffer,
  comment,
}: {
  pageId: string;
  fileName: string;
  fileArrayBuffer: ArrayBuffer;
  comment?: string;
}): Promise<UploadAttachmentResult> {
  if (!CONF_BASE_URL) throw new Error("缺少环境变量 CONF_BASE_URL");
  if (!usePatAuth && (!CONF_USERNAME || !CONF_PASSWORD)) {
    throw new Error("缺少认证配置：请设置 CONF_TOKEN（PAT）或 CONF_USERNAME + CONF_PASSWORD");
  }

  const url = `${CONF_BASE_URL}/rest/api/content/${pageId}/child/attachment`;

  const form = new FormData();
  const blob = new Blob([fileArrayBuffer], { type: "application/octet-stream" });
  form.append("file", blob, fileName);
  if (comment) form.append("comment", comment);

  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: getAuthHeader(),
      "X-Atlassian-Token": "no-check",
      // 注意：不要手动设置 Content-Type，让 fetch 自动带 boundary
    },
    body: form,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`上传附件失败: HTTP ${res.status} ${res.statusText}${text ? ` - ${text}` : ""}`);
  }

  const data = (await res.json()) as any;
  const first = data?.results?.[0] ?? data?.results ?? data;
  const download = first?._links?.download ? `${CONF_BASE_URL}${first._links.download}` : undefined;
  const webui = first?._links?.webui ? `${CONF_BASE_URL}${first._links.webui}` : undefined;

  return {
    id: first?.id,
    title: first?.title ?? first?.filename,
    mediaType: first?.metadata?.mediaType,
    download,
    webui,
  };
}

// ===== Confluence/KMS 宏（macro）辅助 =====

/**
 * CDATA 内部不能出现 "]]>"，需要拆分/转义
 */
function escapeForCdata(text: unknown): string {
  return String(text ?? "").replaceAll("]]>", "]]]]><![CDATA[>");
}

/**
 * Confluence Code Macro 支持的 language 值在不同版本/插件可能有差异。
 * 为了避免 InvalidValueException，这里做常见别名归一化；无法识别时直接不写 language 参数（最稳）。
 */
const CODE_LANGUAGE_ALIASES = new Map<string, string>([
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["node", "javascript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  ["yml", "yaml"],
  ["py", "python"],
  ["golang", "go"],
  ["ps", "powershell"],
]);

const KNOWN_SAFE_CODE_LANGUAGES = new Set<string>([
  "bash",
  "c",
  "cpp",
  "csharp",
  "css",
  "diff",
  "go",
  "groovy",
  "html",
  "ini",
  "java",
  "javascript",
  "json",
  "kotlin",
  "lua",
  "makefile",
  "objectivec",
  "perl",
  "php",
  "plaintext",
  "powershell",
  "python",
  "ruby",
  "rust",
  "scala",
  "sql",
  "swift",
  "typescript",
  "xml",
  "yaml",
]);

function normalizeCodeLanguage(language: unknown): string | null {
  if (!language) return null;
  const raw = String(language).trim().toLowerCase();
  if (!raw) return null;
  const normalized = CODE_LANGUAGE_ALIASES.get(raw) ?? raw;
  return KNOWN_SAFE_CODE_LANGUAGES.has(normalized) ? normalized : null;
}

/**
 * 生成 Confluence/KMS Code Macro（storage format）
 * 尽量只使用最稳的参数，避免 InvalidValueException。
 */
function buildCodeMacro({
  code,
  language,
  linenumbers = false,
  collapse = false,
}: {
  code: string;
  language?: string;
  linenumbers?: boolean;
  collapse?: boolean;
}): string {
  const safeCode = escapeForCdata(code);
  const lang = normalizeCodeLanguage(language);

  const params: string[] = [];
  if (lang) {
    params.push(`<ac:parameter ac:name="language">${lang}</ac:parameter>`);
  }
  if (typeof linenumbers === "boolean") {
    params.push(`<ac:parameter ac:name="linenumbers">${linenumbers ? "true" : "false"}</ac:parameter>`);
  }
  if (typeof collapse === "boolean") {
    params.push(`<ac:parameter ac:name="collapse">${collapse ? "true" : "false"}</ac:parameter>`);
  }

  return (
    `<ac:structured-macro ac:name="code">` +
    params.join("") +
    `<ac:plain-text-body><![CDATA[${safeCode}]]></ac:plain-text-body>` +
    `</ac:structured-macro>`
  );
}

// ===== MCP Server 实现 =====

const server = new Server(
  {
    name: "confluence-kms-mcp-server",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// 列出所有工具
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "confluence_list_spaces",
        description:
          "列出当前用户可访问的所有 Confluence (KMS) Spaces。注意：KMS 是公司内部对 Confluence 知识管理系统的别名，两者是同一个系统。",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              description: "Space 类型: global 或 personal",
              enum: ["global", "personal"],
              default: "global",
            },
          },
        },
      },
      {
        name: "confluence_create_page",
        description: "在指定的 Space 中创建新的 Confluence (KMS) 页面。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            space: {
              type: "string",
              description: "Space Key，如果不提供则使用环境变量中的 CONF_SPACE",
            },
            title: {
              type: "string",
              description: "页面标题",
            },
            content: {
              type: "string",
              description: "页面内容（Confluence Storage Format HTML）",
            },
            parentId: {
              type: "string",
              description: "可选：父页面 ID，用于创建子页面",
            },
            parentTitle: {
              type: "string",
              description: "可选：父页面标题（在同一个 space 下查找并解析出 parentId，用于创建子页面）",
            },
            atRoot: {
              type: "boolean",
              description: "可选：是否创建在 Space 根目录（true/false）。不指定父页面时会先追问确认。",
              default: false,
            },
          },
          required: ["title"],
        },
      },
      {
        name: "confluence_update_page",
        description: "更新现有的 Confluence (KMS) 页面。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            space: {
              type: "string",
              description: "Space Key",
            },
            title: {
              type: "string",
              description: "页面标题（用于查找页面）",
            },
            pageId: {
              type: "string",
              description: "页面 ID（如果提供则直接使用 ID 而不是标题查找）",
            },
            content: {
              type: "string",
              description: "新的页面内容",
            },
            newTitle: {
              type: "string",
              description: "可选：新的页面标题",
            },
          },
        },
      },
      {
        name: "confluence_upsert_page",
        description:
          "创建或更新 Confluence (KMS) 页面（如果页面存在则更新，否则创建）。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            space: {
              type: "string",
              description: "Space Key",
            },
            title: {
              type: "string",
              description: "页面标题",
            },
            content: {
              type: "string",
              description: "页面内容",
            },
            parentId: {
              type: "string",
              description: "可选：父页面 ID（仅在创建新页面时使用）",
            },
            parentTitle: {
              type: "string",
              description: "可选：父页面标题（仅在创建新页面时使用；会在同一个 space 下查找并解析出 parentId）",
            },
            atRoot: {
              type: "boolean",
              description: "可选：是否创建在 Space 根目录（true/false）。不指定父页面时会先追问确认。",
              default: false,
            },
          },
          required: ["title"],
        },
      },
      {
        name: "confluence_get_page",
        description: "获取指定 Confluence (KMS) 页面的详细信息。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            space: {
              type: "string",
              description: "Space Key",
            },
            title: {
              type: "string",
              description: "页面标题",
            },
            pageId: {
              type: "string",
              description: "页面 ID（如果提供则直接使用 ID）",
            },
          },
        },
      },
      {
        name: "confluence_delete_page",
        description: "删除指定的 Confluence (KMS) 页面。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "要删除的页面 ID",
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_search_pages",
        description: "在 Confluence (KMS) 中搜索页面。KMS 是公司内部 Confluence 知识管理系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词",
            },
            space: {
              type: "string",
              description: "可选：限制在指定 Space 中搜索",
            },
            limit: {
              type: "number",
              description: "返回结果数量限制",
              default: 25,
            },
          },
          required: ["query"],
        },
      },
      {
        name: "confluence_get_child_pages",
        description: "获取指定 Confluence (KMS) 页面的所有子页面。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            parentId: {
              type: "string",
              description: "父页面 ID",
            },
            limit: {
              type: "number",
              description: "返回结果数量限制",
              default: 50,
            },
          },
          required: ["parentId"],
        },
      },
      {
        name: "confluence_get_page_history",
        description: "获取 Confluence (KMS) 页面的版本历史。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            limit: {
              type: "number",
              description: "返回历史记录数量",
              default: 10,
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_add_comment",
        description: "在页面评论区添加评论（可选：回复某条评论）。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "要评论的页面 ID",
            },
            content: {
              type: "string",
              description: "评论内容（Confluence Storage Format HTML；纯文本也可，但需自行转义/包裹）",
            },
            parentCommentId: {
              type: "string",
              description: "可选：父评论 ID（用于回复某条评论；不传则为页面下的顶层评论）",
            },
          },
          required: ["pageId", "content"],
        },
      },
      {
        name: "confluence_upload_attachment",
        description:
          "上传附件到指定 Confluence (KMS) 页面。支持本地文件路径(filePath)或 base64 内容(contentBase64)。注意：需要页面编辑权限。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "要上传附件的页面 ID",
            },
            filePath: {
              type: "string",
              description: "本地文件路径（优先使用）。建议使用绝对路径。",
            },
            filename: {
              type: "string",
              description: "附件文件名（当使用 contentBase64 时必填；使用 filePath 时可选）",
            },
            contentBase64: {
              type: "string",
              description: "附件内容 base64（与 filename 配合使用；与 filePath 二选一）",
            },
            comment: {
              type: "string",
              description: "可选：附件备注",
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_build_code_macro",
        description:
          "生成 Confluence (KMS) 的代码宏（storage format HTML），用于安全插入代码块，避免“代码宏出错: InvalidValueException”。",
        inputSchema: {
          type: "object",
          properties: {
            code: {
              type: "string",
              description: "代码内容（原始文本，会自动用 CDATA 包裹并处理特殊序列）",
            },
            language: {
              type: "string",
              description:
                "可选：语言（支持常见别名，如 js/ts/sh/yml，会自动归一化；无法识别时将省略 language 参数）",
            },
            linenumbers: {
              type: "boolean",
              description: "可选：是否显示行号（true/false）",
              default: false,
            },
            collapse: {
              type: "boolean",
              description: "可选：是否折叠（true/false）",
              default: false,
            },
          },
          required: ["code"],
        },
      },
      {
        name: "confluence_get_page_comments",
        description: "获取指定 Confluence (KMS) 页面的所有评论（包括回复）。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            limit: {
              type: "number",
              description: "返回评论数量限制",
              default: 50,
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_set_page_restriction",
        description:
          "设置 Confluence (KMS) 页面的访问权限。支持三种模式：无限制（所有人可访问）、限制编辑（所有人可查看但只有指定用户可编辑）、只有自己能查看（只有指定用户可查看和编辑）。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            restrictionType: {
              type: "string",
              description: "权限类型：none（无限制）、edit_only（限制编辑，所有人可查看）、view_only（只有自己能查看和编辑）",
              enum: ["none", "edit_only", "view_only"],
            },
            username: {
              type: "string",
              description: "可选：指定用户名（默认使用当前登录用户）",
            },
          },
          required: ["pageId", "restrictionType"],
        },
      },
      {
        name: "confluence_search_user_comments",
        description:
          "搜索指定用户在 Confluence (KMS) 中发表的所有评论。可按 Space 和日期范围筛选。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            username: {
              type: "string",
              description: "用户名（评论作者）",
            },
            space: {
              type: "string",
              description: "可选：限制在指定 Space 中搜索",
            },
            startDate: {
              type: "string",
              description: "可选：开始日期（格式：YYYY-MM-DD），搜索该日期及之后的评论",
            },
            endDate: {
              type: "string",
              description: "可选：结束日期（格式：YYYY-MM-DD），搜索该日期及之前的评论",
            },
            limit: {
              type: "number",
              description: "返回结果数量限制",
              default: 50,
            },
          },
          required: ["username"],
        },
      },
    ],
  };
});

type CallToolArgs = Record<string, unknown> & {
  // common
  space?: string;
  title?: string;
  pageId?: string;
  content?: string;
  parentId?: string;
  parentTitle?: string;
  atRoot?: boolean;
  query?: string;
  limit?: number;
  newTitle?: string;
  // comment
  parentCommentId?: string;
  // attachment
  filePath?: string;
  filename?: string;
  contentBase64?: string;
  comment?: string;
  // code macro
  code?: string;
  language?: string;
  linenumbers?: boolean;
  collapse?: boolean;
  // list spaces
  type?: "global" | "personal";
  // restriction
  restrictionType?: RestrictionType;
  username?: string;
  // date filter
  startDate?: string;
  endDate?: string;
};

type CallToolRequestParams = {
  name: string;
  arguments?: CallToolArgs;
};

type CallToolRequest = {
  params: CallToolRequestParams;
};

async function resolveParentIdForCreate({
  space,
  parentId,
  parentTitle,
  atRoot,
}: {
  space: string;
  parentId?: string;
  parentTitle?: string;
  atRoot?: boolean;
}): Promise<{ parentId: string | null; prompt?: never } | { parentId?: never; prompt: string }> {
  if (atRoot === true) {
    return { parentId: null };
  }

  if (parentId) {
    return { parentId };
  }

  if (parentTitle) {
    const parent = await getPage(space, parentTitle);
    if (!parent) {
      throw new Error(`未找到父页面: ${parentTitle}（space=${space}）`);
    }
    return { parentId: parent.id };
  }

  return {
    prompt:
      "创建页面前需要确认“要创建到哪个父页面下”。\n\n" +
      "请你回复以下任意一种信息，然后我会把页面创建到该父页面之下：\n" +
      "1) 父页面 ID（推荐）：直接告诉我 parentId\n" +
      "2) 父页面标题：告诉我 parentTitle（我会在同一个 space 下用标题查找并解析出 parentId）\n" +
      "3) 如果你就是要创建在 Space 根目录：请明确传 atRoot=true\n\n" +
      "小提示：如果你不确定父页面，可以先用 confluence_search_pages 搜索父页面标题拿到 id。",
  };
}

// 处理工具调用
server.setRequestHandler(CallToolRequestSchema, async (request: CallToolRequest) => {
  const { name, arguments: argsRaw } = request.params;
  const args = (argsRaw ?? {}) as CallToolArgs;

  try {
    switch (name) {
      case "confluence_list_spaces": {
        const spaces = await listAllSpaces({ type: args.type || "global" });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(spaces, null, 2),
            },
          ],
        };
      }

      case "confluence_create_page": {
        const space = (args.space as string | undefined) || CONF_SPACE;
        const content = args.content as string | undefined;

        if (!space) {
          throw new Error("必须提供 space（或在环境变量中配置 CONF_SPACE）");
        }

        const parentResolve = await resolveParentIdForCreate({
          space,
          parentId: (args.parentId as string | undefined) ?? undefined,
          parentTitle: (args.parentTitle as string | undefined) ?? undefined,
          atRoot: (args.atRoot as boolean | undefined) ?? undefined,
        });

        if ("prompt" in parentResolve) {
          return {
            content: [
              {
                type: "text",
                text: parentResolve.prompt,
              },
            ],
          };
        }

        if (!content) {
          throw new Error("必须提供 content");
        }

        const result = await createPage(space, args.title as string, content, parentResolve.parentId);

        return {
          content: [
            {
              type: "text",
              text: `✅ 页面创建成功！\n\nID: ${result.id}\n标题: ${result.title}\nURL: ${CONF_BASE_URL}${result._links.webui}`,
            },
          ],
        };
      }

      case "confluence_update_page": {
        let page: ConfluencePage | undefined;

        if (args.pageId) {
          page = await getPageById(args.pageId as string);
        } else {
          const space = (args.space as string | undefined) || CONF_SPACE;
          page = await getPage(space ?? "", args.title as string);
          if (!page) {
            throw new Error(`页面不存在: ${args.title}`);
          }
        }

        const content = args.content as string;
        const result = await updatePage(page, content, (args.newTitle as string) ?? null);

        return {
          content: [
            {
              type: "text",
              text: `✅ 页面更新成功！\n\nID: ${result.id}\n标题: ${result.title}\n版本: ${result.version.number}\nURL: ${CONF_BASE_URL}${result._links.webui}`,
            },
          ],
        };
      }

      case "confluence_upsert_page": {
        const space = (args.space as string | undefined) || CONF_SPACE;
        const content = args.content as string | undefined;

        if (!space) {
          throw new Error("必须提供 space（或在环境变量中配置 CONF_SPACE）");
        }

        if (!content) {
          throw new Error("必须提供 content");
        }

        const existingPage = await getPage(space, args.title as string);

        let result: ConfluencePage;
        if (existingPage) {
          result = await updatePage(existingPage, content);
          return {
            content: [
              {
                type: "text",
                text: `✅ 页面更新成功！\n\nID: ${result.id}\n标题: ${result.title}\n版本: ${result.version.number}\nURL: ${CONF_BASE_URL}${result._links.webui}`,
              },
            ],
          };
        }

        const parentResolve = await resolveParentIdForCreate({
          space,
          parentId: (args.parentId as string | undefined) ?? undefined,
          parentTitle: (args.parentTitle as string | undefined) ?? undefined,
          atRoot: (args.atRoot as boolean | undefined) ?? undefined,
        });

        if ("prompt" in parentResolve) {
          return {
            content: [
              {
                type: "text",
                text: parentResolve.prompt,
              },
            ],
          };
        }

        result = await createPage(space, args.title as string, content, parentResolve.parentId);
        return {
          content: [
            {
              type: "text",
              text: `✅ 页面创建成功！\n\nID: ${result.id}\n标题: ${result.title}\nURL: ${CONF_BASE_URL}${result._links.webui}`,
            },
          ],
        };
      }

      case "confluence_get_page": {
        let page: ConfluencePage | undefined;

        if (args.pageId) {
          page = await getPageById(args.pageId as string);
        } else {
          const space = (args.space as string | undefined) || CONF_SPACE;
          page = await getPage(space ?? "", args.title as string);
        }

        if (!page) {
          throw new Error("页面不存在");
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  id: page.id,
                  title: page.title,
                  version: page.version.number,
                  space: page.space.key,
                  url: `${CONF_BASE_URL}${page._links.webui}`,
                  content: page.body?.storage?.value,
                },
                null,
                2
              ),
            },
          ],
        };
      }

      case "confluence_delete_page": {
        await deletePage(args.pageId as string);
        return {
          content: [
            {
              type: "text",
              text: "✅ 页面已成功删除",
            },
          ],
        };
      }

      case "confluence_search_pages": {
        const results = await searchPages(args.space as string | undefined, args.query as string, (args.limit as number) || 25);

        const formatted = results.map((p) => ({
          id: p.id,
          title: p.title,
          space: p.space.key,
          version: p.version.number,
          url: `${CONF_BASE_URL}${p._links.webui}`,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      case "confluence_get_child_pages": {
        const children = await getChildPages(args.parentId as string, (args.limit as number) || 50);

        const formatted = children.map((p) => ({
          id: p.id,
          title: p.title,
          space: p.space.key,
          version: p.version.number,
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(formatted, null, 2),
            },
          ],
        };
      }

      case "confluence_get_page_history": {
        const history = await getPageHistory(args.pageId as string, (args.limit as number) || 10);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(history, null, 2),
            },
          ],
        };
      }

      case "confluence_add_comment": {
        if (!CONF_BASE_URL) throw new Error("缺少环境变量 CONF_BASE_URL");
        if (!args.pageId) throw new Error("必须提供 pageId");
        if (!args.content) throw new Error("必须提供 content");

        const result = await addCommentToPage({
          pageId: String(args.pageId),
          commentHtml: String(args.content),
          parentCommentId: (args.parentCommentId as string | undefined) ?? undefined,
        });

        const webui = result?._links?.webui ? `${CONF_BASE_URL}${result._links.webui}` : undefined;

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 评论添加成功！\n\n` +
                `页面ID: ${String(args.pageId)}\n` +
                `评论ID: ${result.id}\n` +
                (args.parentCommentId ? `父评论ID: ${String(args.parentCommentId)}\n` : "") +
                (webui ? `URL: ${webui}\n` : ""),
            },
          ],
        };
      }

      case "confluence_upload_attachment": {
        if (!args.pageId) throw new Error("必须提供 pageId");

        let fileName: string | undefined;
        let fileArrayBuffer: ArrayBuffer | undefined;

        if (args.filePath) {
          const p = String(args.filePath);
          if (!fs.existsSync(p)) {
            throw new Error(`文件不存在: ${p}`);
          }
          const buf = fs.readFileSync(p);
          fileArrayBuffer = Uint8Array.from(buf).buffer; // 确保是 ArrayBuffer（避免 ArrayBufferLike/SharedArrayBuffer 类型问题）
          fileName = (args.filename as string | undefined) || path.basename(p);
        } else if (args.contentBase64) {
          fileName = args.filename as string | undefined;
          if (!fileName) throw new Error("使用 contentBase64 时必须提供 filename");
          const buf = Buffer.from(String(args.contentBase64), "base64");
          fileArrayBuffer = Uint8Array.from(buf).buffer;
        } else {
          throw new Error("必须提供 filePath 或 contentBase64（二选一）");
        }

        const result = await uploadAttachmentToPage({
          pageId: String(args.pageId),
          fileName,
          fileArrayBuffer: fileArrayBuffer!,
          comment: (args.comment as string | undefined) ?? undefined,
        });

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 附件上传成功！\n\n` +
                `页面ID: ${String(args.pageId)}\n` +
                (result.id ? `附件ID: ${result.id}\n` : "") +
                (result.title ? `文件名: ${result.title}\n` : "") +
                (result.download ? `下载: ${result.download}\n` : "") +
                (result.webui ? `页面: ${result.webui}\n` : ""),
            },
          ],
        };
      }

      case "confluence_build_code_macro": {
        const macro = buildCodeMacro({
          code: args.code as string,
          language: (args.language as string) ?? undefined,
          linenumbers: (args.linenumbers as boolean) ?? false,
          collapse: (args.collapse as boolean) ?? false,
        });
        return {
          content: [
            {
              type: "text",
              text: macro,
            },
          ],
        };
      }

      case "confluence_get_page_comments": {
        if (!args.pageId) throw new Error("必须提供 pageId");

        const comments = await getPageComments(String(args.pageId), (args.limit as number) || 50);

        const formatted = comments.map((c) => ({
          id: c.id,
          title: c.title,
          body: c.body?.storage?.value,
        }));

        return {
          content: [
            {
              type: "text",
              text:
                comments.length > 0
                  ? `共找到 ${comments.length} 条评论：\n\n${JSON.stringify(formatted, null, 2)}`
                  : "该页面暂无评论",
            },
          ],
        };
      }

      case "confluence_set_page_restriction": {
        if (!args.pageId) throw new Error("必须提供 pageId");
        if (!args.restrictionType) throw new Error("必须提供 restrictionType");

        const result = await setPageRestriction({
          pageId: String(args.pageId),
          restrictionType: args.restrictionType,
          username: (args.username as string | undefined) ?? undefined,
        });

        return {
          content: [
            {
              type: "text",
              text: `✅ ${result.message}`,
            },
          ],
        };
      }

      case "confluence_search_user_comments": {
        if (!args.username) throw new Error("必须提供 username");

        const comments = await searchUserComments({
          username: String(args.username),
          space: (args.space as string | undefined) ?? undefined,
          startDate: (args.startDate as string | undefined) ?? undefined,
          endDate: (args.endDate as string | undefined) ?? undefined,
          limit: (args.limit as number) || 50,
        });

        const formatted = comments.map((c) => ({
          id: c.id,
          body: c.body?.storage?.value,
          container: c.container
            ? { id: c.container.id, title: c.container.title, type: c.container.type }
            : undefined,
          space: c.space ? { key: c.space.key, name: c.space.name } : undefined,
          createdAt: c.version?.when,
          url: c._links?.webui ? `${CONF_BASE_URL}${c._links.webui}` : undefined,
        }));

        return {
          content: [
            {
              type: "text",
              text:
                comments.length > 0
                  ? `共找到 ${comments.length} 条 ${args.username} 的评论：\n\n${JSON.stringify(formatted, null, 2)}`
                  : `未找到用户 ${args.username} 的评论`,
            },
          ],
        };
      }

      default:
        throw new Error(`未知的工具: ${name}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [
        {
          type: "text",
          text: `❌ 错误: ${message}`,
        },
      ],
      isError: true,
    };
  }
});

// 启动服务器
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Confluence (KMS) MCP Server 已启动");
}

main().catch((error) => {
  console.error("服务器错误:", error);
  process.exit(1);
});


