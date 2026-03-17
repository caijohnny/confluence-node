#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import dotenv from "dotenv";
import express, { Request, Response } from "express";
import { createServer } from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import os from "node:os";

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

const experimentalApi = axios.create({
  baseURL: `${CONF_BASE_URL}/rest/experimental`,
  ...authConfig,
  headers: {
    "Content-Type": "application/json",
    ...authConfig.headers,
  },
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
          value: sanitizeCodeMacros(content),
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
          value: sanitizeCodeMacros(content),
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

async function movePage(pageId: string, position: "above" | "below" | "append", targetId: string): Promise<void> {
  // Confluence Server 没有 REST move API，使用 JSON-RPC API
  await axios.post(
    `${CONF_BASE_URL}/rpc/json-rpc/confluenceservice-v2/movePage`,
    [pageId, targetId, position],
    {
      ...authConfig,
      headers: {
        "Content-Type": "application/json",
        ...authConfig.headers,
      },
    }
  );
}

async function sortChildPages(
  parentId: string,
  sortBy: "title" | "custom" = "title",
  order: "asc" | "desc" = "asc",
  pageIds?: string[]
): Promise<{ sorted: { id: string; title: string }[] }> {
  const children = await getChildPages(parentId);

  let sorted: ConfluencePage[];
  if (sortBy === "custom") {
    if (!pageIds || pageIds.length === 0) {
      throw new Error("custom 排序模式下必须提供 pageIds 参数");
    }
    const childMap = new Map(children.map((p) => [p.id, p]));
    const unknownIds = pageIds.filter((id) => !childMap.has(id));
    if (unknownIds.length > 0) {
      throw new Error(`以下 pageIds 不是父页面 ${parentId} 的子页面: ${unknownIds.join(", ")}`);
    }
    sorted = pageIds.map((id) => childMap.get(id)!);
    // 将未在 pageIds 中指定的子页面追加到末尾
    for (const child of children) {
      if (!pageIds.includes(child.id)) {
        sorted.push(child);
      }
    }
  } else {
    sorted = [...children].sort((a, b) => {
      const cmp = a.title.localeCompare(b.title, "zh-Hans");
      return order === "desc" ? -cmp : cmp;
    });
  }

  // 逐个移动页面：第一个 append 到父页面，后续 below 前一个
  for (let i = 0; i < sorted.length; i++) {
    if (i === 0) {
      await movePage(sorted[i].id, "append", parentId);
    } else {
      await movePage(sorted[i].id, "below", sorted[i - 1].id);
    }
  }

  return {
    sorted: sorted.map((p) => ({ id: p.id, title: p.title })),
  };
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

type PageVersionInfo = {
  number: number;
  by: { displayName?: string; username?: string };
  when: string;
  message?: string;
  minorEdit: boolean;
};

/**
 * 获取页面的所有版本列表（含版本号、作者、时间、版本备注等）
 * 通过逐个请求历史版本实现，兼容 Confluence Server
 */
async function getPageVersions(
  pageId: string,
  limit = 20,
  start = 0
): Promise<{ versions: Array<PageVersionInfo & { versionUrl: string }>; totalCount: number; pageTitle: string }> {
  try {
    // 获取页面基本信息（当前版本号 + 标题）
    const pageRes = await api.get<ConfluencePage>(`/content/${pageId}`, {
      params: { expand: "version" },
    });
    const page = pageRes.data;
    const currentVersion = page.version.number;
    const pageTitle = page.title;
    const totalCount = currentVersion;

    // 计算需要获取的版本范围（从最新往回取）
    const endVersion = Math.max(currentVersion - start, 1);
    const startVersion = Math.max(endVersion - limit + 1, 1);

    // 并发获取各版本的信息
    const versionNumbers: number[] = [];
    for (let v = endVersion; v >= startVersion; v--) {
      versionNumbers.push(v);
    }

    type VersionEntry = PageVersionInfo & { versionUrl: string };

    const versionPromises = versionNumbers.map(async (vNum): Promise<VersionEntry | null> => {
      try {
        const res = await api.get(`/content/${pageId}`, {
          params: {
            expand: "version",
            version: vNum,
          },
        });
        const data = res.data;
        return {
          number: data.version.number as number,
          by: {
            displayName: data.version.by?.displayName,
            username: data.version.by?.username,
          },
          when: data.version.when as string,
          message: (data.version.message as string) || "",
          minorEdit: (data.version.minorEdit as boolean) ?? false,
          versionUrl:
            vNum === currentVersion
              ? `${CONF_BASE_URL}/pages/viewpage.action?pageId=${pageId}`
              : `${CONF_BASE_URL}/pages/viewpage.action?pageId=${pageId}&pageVersion=${vNum}`,
        };
      } catch {
        return null;
      }
    });

    const results = (await Promise.all(versionPromises)).filter(
      (v): v is VersionEntry => v !== null
    );

    return { versions: results, totalCount, pageTitle };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面版本列表失败: ${message}`);
  }
}

/**
 * 获取页面某个特定版本的详细内容
 */
async function getPageVersionDetail(
  pageId: string,
  versionNumber: number
): Promise<{
  pageId: string;
  title: string;
  versionNumber: number;
  by: { displayName?: string; username?: string };
  when: string;
  message: string;
  content: string;
  versionUrl: string;
}> {
  try {
    const res = await api.get(`/content/${pageId}`, {
      params: {
        expand: "body.storage,version,space",
        version: versionNumber,
      },
    });

    const data = res.data;
    return {
      pageId: data.id,
      title: data.title,
      versionNumber: data.version.number,
      by: {
        displayName: data.version.by?.displayName,
        username: data.version.by?.username,
      },
      when: data.version.when,
      message: data.version.message || "",
      content: data.body?.storage?.value || "",
      versionUrl: `${CONF_BASE_URL}/pages/viewpage.action?pageId=${pageId}&pageVersion=${versionNumber}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面版本详情失败: ${message}`);
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

// ===== 附件相关 =====

type ConfluenceAttachment = {
  id: string;
  title: string;
  mediaType?: string;
  fileSize?: number;
  _links: {
    download?: string;
    webui?: string;
  };
};

type UploadAttachmentResult = {
  id?: string;
  title?: string;
  mediaType?: string;
  download?: string;
  webui?: string;
};

/**
 * 获取页面的附件列表
 */
async function getPageAttachments(pageId: string, limit = 100): Promise<ConfluenceAttachment[]> {
  try {
    const res = await api.get<{ results: ConfluenceAttachment[] }>(`/content/${pageId}/child/attachment`, {
      params: {
        limit,
        expand: "metadata.mediaType",
      },
    });
    return res.data.results;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`获取页面附件列表失败: ${message}`);
  }
}

/**
 * 下载附件内容
 */
async function downloadAttachment(downloadPath: string): Promise<ArrayBuffer> {
  if (!CONF_BASE_URL) throw new Error("缺少环境变量 CONF_BASE_URL");

  // downloadPath 可能是相对路径（如 /download/attachments/...）或绝对路径
  const url = downloadPath.startsWith("http") ? downloadPath : `${CONF_BASE_URL}${downloadPath}`;

  const res = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: getAuthHeader(),
    },
  });

  if (!res.ok) {
    throw new Error(`下载附件失败: HTTP ${res.status} ${res.statusText}`);
  }

  return await res.arrayBuffer();
}

/**
 * 复制页面的所有附件到目标页面
 */
async function copyPageAttachments(
  sourcePageId: string,
  targetPageId: string
): Promise<{ success: number; failed: number; details: Array<{ name: string; success: boolean; error?: string }> }> {
  const attachments = await getPageAttachments(sourcePageId);
  const results: Array<{ name: string; success: boolean; error?: string }> = [];

  for (const attachment of attachments) {
    try {
      if (!attachment._links.download) {
        results.push({ name: attachment.title, success: false, error: "无下载链接" });
        continue;
      }

      // 下载附件
      const content = await downloadAttachment(attachment._links.download);

      // 上传到目标页面
      await uploadAttachmentToPage({
        pageId: targetPageId,
        fileName: attachment.title,
        fileArrayBuffer: content,
      });

      results.push({ name: attachment.title, success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ name: attachment.title, success: false, error: message });
    }
  }

  return {
    success: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    details: results,
  };
}

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

// ===== Mermaid 渲染 =====

async function renderMermaidToImage(
  mermaidCode: string,
  options?: { theme?: string; bgColor?: string; width?: number; height?: number }
): Promise<{ imageBuffer: ArrayBuffer; url: string }> {
  const baseUrl = process.env.MERMAID_INK_URL || "https://mermaid.ink";

  // 确保正确处理 UTF-8 编码的中文字符
  const encoded = Buffer.from(mermaidCode, "utf8").toString("base64");

  // URL 安全的 base64 编码（替换 URL 中不安全的字符）
  const urlSafeEncoded = encoded.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

  let imgUrl = `${baseUrl}/img/${urlSafeEncoded}`;
  const params = new URLSearchParams();
  if (options?.theme) params.set("theme", options.theme);
  if (options?.bgColor) params.set("bgColor", options.bgColor);
  if (options?.width) params.set("width", String(options.width));
  if (options?.height) params.set("height", String(options.height));
  const qs = params.toString();
  if (qs) imgUrl += `?${qs}`;

  const res = await fetch(imgUrl);
  if (!res.ok) {
    // 如果URL安全编码失败，尝试使用原始base64编码（但进行URL编码）
    if (urlSafeEncoded !== encoded) {
      console.warn(`Mermaid 渲染失败，尝试使用原始编码: HTTP ${res.status}`);
      const fallbackUrl = `${baseUrl}/img/${encodeURIComponent(encoded)}${qs ? `?${qs}` : ''}`;
      const fallbackRes = await fetch(fallbackUrl);
      if (fallbackRes.ok) {
        return { imageBuffer: await fallbackRes.arrayBuffer(), url: fallbackUrl };
      }
    }
    throw new Error(`Mermaid 渲染失败: HTTP ${res.status} ${res.statusText}。可能是包含了不支持的字符或语法错误。`);
  }

  return { imageBuffer: await res.arrayBuffer(), url: imgUrl };
}

// ===== Confluence/KMS 宏（macro）辅助 =====

/**
 * CDATA 内部不能出现 "]]>"，需要拆分/转义
 */
function escapeForCdata(text: unknown): string {
  return String(text ?? "").replaceAll("]]>", "]]]]><![CDATA[>");
}

/**
 * Confluence Code Macro 支持的 language 值（基于官方文档）。
 * 为了避免 InvalidValueException，这里做常见别名归一化；无法识别时直接不写 language 参数（最稳）。
 *
 * 官方支持：ActionScript, AppleScript, Bash, C#, C++, CSS, ColdFusion, Delphi,
 * Diff, Erlang, Groovy, HTML and XML, Java, Java FX, JavaScript, PHP, Perl,
 * Plain Text, PowerShell, Python, Ruby, SQL, Sass, Scala, Visual Basic, YAML
 */
const CODE_LANGUAGE_ALIASES = new Map<string, string>([
  // JavaScript
  ["js", "javascript"],
  ["jsx", "javascript"],
  ["node", "javascript"],
  // Bash / Shell
  ["sh", "bash"],
  ["shell", "bash"],
  ["zsh", "bash"],
  // YAML
  ["yml", "yaml"],
  // Python
  ["py", "python"],
  // PowerShell
  ["ps", "powershell"],
  ["ps1", "powershell"],
  // C#
  ["c#", "csharp"],
  ["cs", "csharp"],
  ["dotnet", "csharp"],
  // C++
  ["c++", "cpp"],
  ["cc", "cpp"],
  ["cxx", "cpp"],
  // C → 归入 C++（Confluence 无独立 C）
  ["c", "cpp"],
  // HTML / XML
  ["htm", "html"],
  ["xhtml", "html"],
  ["xsl", "xml"],
  ["xslt", "xml"],
  // Plain Text
  ["text", "plain"],
  ["plaintext", "plain"],
  ["txt", "plain"],
  ["none", "plain"],
  // ActionScript
  ["actionscript", "actionscript3"],
  ["as", "actionscript3"],
  ["as3", "actionscript3"],
  // Visual Basic
  ["visualbasic", "vb"],
  ["vbnet", "vb"],
  ["vb.net", "vb"],
  ["vbs", "vb"],
  ["vbscript", "vb"],
  // Sass
  ["scss", "sass"],
  // TypeScript → 归入 JavaScript（Confluence 无独立 TypeScript）
  ["ts", "javascript"],
  ["tsx", "javascript"],
  ["typescript", "javascript"],
  // 常见但不支持的语言 → 归入 plain
  ["go", "plain"],
  ["golang", "plain"],
  ["rust", "plain"],
  ["rs", "plain"],
  ["kotlin", "plain"],
  ["kt", "plain"],
  ["swift", "plain"],
  ["lua", "plain"],
  ["json", "plain"],
  ["ini", "plain"],
  ["toml", "plain"],
  ["makefile", "plain"],
  ["make", "plain"],
  ["dockerfile", "plain"],
  ["docker", "plain"],
  ["objectivec", "plain"],
  ["objc", "plain"],
]);

const KNOWN_SAFE_CODE_LANGUAGES = new Set<string>([
  "actionscript3",
  "applescript",
  "bash",
  "coldfusion",
  "cpp",
  "csharp",
  "css",
  "delphi",
  "diff",
  "erlang",
  "groovy",
  "html",
  "java",
  "javafx",
  "javascript",
  "perl",
  "php",
  "plain",
  "powershell",
  "python",
  "ruby",
  "sass",
  "scala",
  "sql",
  "vb",
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
 * 扫描 storage-format HTML 中的代码宏，将无效的 language 参数归一化或移除，
 * 防止 Confluence 抛出 InvalidValueException。
 *
 * 在 createPage / updatePage 写入内容前自动调用。
 */
function sanitizeCodeMacros(html: string): string {
  // 匹配 code 宏中的 language 参数：<ac:parameter ac:name="language">xxx</ac:parameter>
  // 使用非贪婪匹配，限定在 <ac:structured-macro ac:name="code"> 上下文中
  return html.replace(
    /(<ac:structured-macro\s[^>]*ac:name="code"[^>]*>)([\s\S]*?)(<\/ac:structured-macro>)/g,
    (_match, open: string, inner: string, close: string) => {
      const sanitizedInner = inner.replace(
        /<ac:parameter\s+ac:name="language">([\s\S]*?)<\/ac:parameter>/g,
        (_paramMatch: string, langValue: string) => {
          const normalized = normalizeCodeLanguage(langValue);
          if (normalized) {
            return `<ac:parameter ac:name="language">${normalized}</ac:parameter>`;
          }
          // 无法识别的 language 直接移除该参数，让 Confluence 使用默认（纯文本）
          return "";
        }
      );
      return open + sanitizedInner + close;
    }
  );
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
  // copy page
  sourcePageId?: string;
  targetSpace?: string;
  copyAttachments?: boolean;
  // mermaid
  mermaidCode?: string;
  embedInPage?: boolean;
  theme?: string;
  bgColor?: string;
  width?: number;
  height?: number;
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

// ===== 命令行参数解析 =====

function parseArgs(): { mode: "stdio" | "http"; port: number } {
  const args = process.argv.slice(2);
  let mode: "stdio" | "http" = "stdio";
  let port = 3000;

  for (const arg of args) {
    if (arg === "--http" || arg === "-h") {
      mode = "http";
    } else if (arg.startsWith("--port=")) {
      port = parseInt(arg.split("=")[1], 10);
      mode = "http"; // 指定端口时自动切换到 HTTP 模式
    } else if (arg === "--stdio" || arg === "-s") {
      mode = "stdio";
    }
  }

  return { mode, port };
}

// ===== 启动服务器 =====

// 用于存储 HTTP 模式下的 transport 实例（按 sessionId 索引）
const httpTransports = new Map<string, StreamableHTTPServerTransport>();

async function startHttpServer(port: number): Promise<void> {
  const app = express();

  // 解析 JSON 请求体
  app.use(express.json());

  // MCP 端点 - 处理所有 MCP 请求
  app.all("/mcp", async (req: Request, res: Response) => {
    // 获取或创建 session
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (req.method === "GET") {
      // GET 请求 - 建立 SSE 连接
      // 对于 GET 请求，如果没有 sessionId，返回错误
      if (!sessionId || !httpTransports.has(sessionId)) {
        res.status(400).json({ error: "Missing or invalid session ID. Send a POST request first to initialize." });
        return;
      }

      const transport = httpTransports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    if (req.method === "POST") {
      // POST 请求 - 处理 MCP 消息
      if (sessionId && httpTransports.has(sessionId)) {
        // 已有 session，复用 transport
        const transport = httpTransports.get(sessionId)!;
        await transport.handleRequest(req, res, req.body);
        return;
      }

      // 新 session - 创建新的 transport 和 server
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      // 创建新的 server 实例并连接
      const serverInstance = new Server(
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

      // 注册工具处理器（复用已定义的 handlers）
      setupServerHandlers(serverInstance);

      await serverInstance.connect(transport);

      // 保存 transport
      const newSessionId = transport.sessionId;
      if (newSessionId) {
        httpTransports.set(newSessionId, transport);

        // 监听关闭事件，清理 transport
        transport.onclose = () => {
          httpTransports.delete(newSessionId);
          console.error(`Session ${newSessionId} closed`);
        };
      }

      // 处理请求
      await transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method === "DELETE") {
      // DELETE 请求 - 关闭 session
      if (sessionId && httpTransports.has(sessionId)) {
        const transport = httpTransports.get(sessionId)!;
        await transport.close();
        httpTransports.delete(sessionId);
        res.status(200).json({ message: "Session closed" });
        return;
      }
      res.status(404).json({ error: "Session not found" });
      return;
    }

    // 不支持的方法
    res.status(405).json({ error: "Method not allowed" });
  });

  // 健康检查端点
  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", mode: "http", sessions: httpTransports.size });
  });

  // 启动 HTTP 服务器
  const httpServer = createServer(app);
  httpServer.listen(port, () => {
    console.error(`Confluence (KMS) MCP Server 已启动 (HTTP 模式)`);
    console.error(`  - MCP 端点: http://localhost:${port}/mcp`);
    console.error(`  - 健康检查: http://localhost:${port}/health`);
  });
}

async function startStdioServer(): Promise<void> {
  const transport = new StdioServerTransport();

  // 创建 server 实例
  const serverInstance = new Server(
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

  setupServerHandlers(serverInstance);
  await serverInstance.connect(transport);
  console.error("Confluence (KMS) MCP Server 已启动 (stdio 模式)");
}

// 设置服务器的请求处理器
function setupServerHandlers(serverInstance: Server): void {
  // 列出所有工具
  serverInstance.setRequestHandler(ListToolsRequestSchema, async () => {
    return getToolsList();
  });

  // 处理工具调用
  serverInstance.setRequestHandler(CallToolRequestSchema, handleToolCall);
}

// 获取工具列表（提取为函数以便复用）
function getToolsList() {
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
        name: "confluence_download_attachment",
        description:
          "下载 Confluence (KMS) 页面的附件到本地。默认保存到用户的下载目录。",
        inputSchema: {
          type: "object",
          properties: {
            downloadUrl: {
              type: "string",
              description: "附件的下载 URL（可以从 confluence_get_page_attachments 获取）",
            },
            filename: {
              type: "string",
              description: "保存的文件名（可选，如果不提供则从 URL 中提取）",
            },
            outputDir: {
              type: "string",
              description: "保存目录（可选，默认为用户的下载目录）",
            },
          },
          required: ["downloadUrl"],
        },
      },
      {
        name: "confluence_build_code_macro",
        description:
          "生成 Confluence (KMS) 的代码宏（storage format HTML），用于安全插入代码块，避免 InvalidValueException 错误。",
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
      {
        name: "confluence_get_page_attachments",
        description: "获取指定 Confluence (KMS) 页面的所有附件列表。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            limit: {
              type: "number",
              description: "返回结果数量限制",
              default: 100,
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_copy_page",
        description:
          "复制 Confluence (KMS) 页面到新位置。支持复制页面内容和附件。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            sourcePageId: {
              type: "string",
              description: "源页面 ID（要复制的页面）",
            },
            targetSpace: {
              type: "string",
              description: "目标 Space Key（如果不提供则使用源页面的 Space）",
            },
            newTitle: {
              type: "string",
              description: "新页面标题",
            },
            parentId: {
              type: "string",
              description: "可选：新页面的父页面 ID",
            },
            parentTitle: {
              type: "string",
              description: "可选：新页面的父页面标题（会自动查找 ID）",
            },
            atRoot: {
              type: "boolean",
              description: "可选：是否创建在 Space 根目录",
              default: false,
            },
            copyAttachments: {
              type: "boolean",
              description: "是否复制附件（默认为 true）",
              default: true,
            },
          },
          required: ["sourcePageId", "newTitle"],
        },
      },
      {
        name: "confluence_render_mermaid",
        description:
          "将 Mermaid 图表文本渲染为 PNG 图片，上传为 Confluence (KMS) 页面附件，并可选嵌入页面内容。通过 mermaid.ink 在线服务渲染，支持自建服务（环境变量 MERMAID_INK_URL）。",
        inputSchema: {
          type: "object",
          properties: {
            mermaidCode: {
              type: "string",
              description: "Mermaid 图表文本，例如 'graph TD; A-->B;'",
            },
            pageId: {
              type: "string",
              description: "要上传附件的页面 ID",
            },
            filename: {
              type: "string",
              description: "附件文件名（默认 mermaid-diagram.png）",
              default: "mermaid-diagram.png",
            },
            theme: {
              type: "string",
              description: "Mermaid 主题",
              enum: ["default", "forest", "dark", "neutral"],
            },
            bgColor: {
              type: "string",
              description: "背景色，例如 'white'、'!white'（透明背景加 ! 前缀）",
            },
            width: {
              type: "number",
              description: "图片宽度（像素）",
            },
            height: {
              type: "number",
              description: "图片高度（像素）",
            },
            embedInPage: {
              type: "boolean",
              description: "是否自动将图片嵌入页面末尾（默认 false）",
              default: false,
            },
          },
          required: ["mermaidCode", "pageId"],
        },
      },
      {
        name: "confluence_fix_code_macros",
        description:
          "修复 Confluence (KMS) 页面中代码宏的 InvalidValueException 错误。自动扫描页面内容，将无效的 language 参数归一化或移除，然后更新页面。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "要修复的页面 ID",
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_move_page",
        description:
          "将 Confluence (KMS) 页面移动到另一个页面下（成为目标页面的子页面），或移动到目标页面的前面/后面（成为同级页面）。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "要移动的页面 ID",
            },
            targetPageId: {
              type: "string",
              description: "目标页面 ID",
            },
            position: {
              type: "string",
              enum: ["append", "above", "below"],
              description:
                "移动位置：append=成为目标页面的子页面（追加到末尾），above=移动到目标页面前面（同级），below=移动到目标页面后面（同级）。默认 append。",
              default: "append",
            },
          },
          required: ["pageId", "targetPageId"],
        },
      },
      {
        name: "confluence_sort_child_pages",
        description:
          "对 Confluence (KMS) 父页面下的子页面进行排序。支持按标题字母排序或按自定义顺序排序。",
        inputSchema: {
          type: "object",
          properties: {
            parentId: {
              type: "string",
              description: "父页面 ID",
            },
            sortBy: {
              type: "string",
              enum: ["title", "custom"],
              description: "排序方式：title=按标题字母排序，custom=按自定义顺序排序",
              default: "title",
            },
            order: {
              type: "string",
              enum: ["asc", "desc"],
              description: "排序方向（仅 sortBy=title 时有效），默认 asc",
              default: "asc",
            },
            pageIds: {
              type: "array",
              items: { type: "string" },
              description: "自定义排序的页面 ID 列表（仅 sortBy=custom 时必填），按此顺序排列",
            },
          },
          required: ["parentId"],
        },
      },
      {
        name: "confluence_get_page_versions",
        description:
          "获取 Confluence (KMS) 页面的版本列表，包含每个版本的版本号、作者、修改时间、版本备注以及对应的版本链接。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            limit: {
              type: "number",
              description: "返回版本数量，默认 20",
              default: 20,
            },
            start: {
              type: "number",
              description: "分页起始位置，默认 0",
              default: 0,
            },
          },
          required: ["pageId"],
        },
      },
      {
        name: "confluence_get_page_version_detail",
        description:
          "获取 Confluence (KMS) 页面某个特定版本的详细内容，包括该版本的正文内容、作者、修改时间和版本链接。KMS 是公司内部 Confluence 系统的别名。",
        inputSchema: {
          type: "object",
          properties: {
            pageId: {
              type: "string",
              description: "页面 ID",
            },
            versionNumber: {
              type: "number",
              description: "版本号",
            },
          },
          required: ["pageId", "versionNumber"],
        },
      },
    ],
  };
}

// 处理工具调用（提取为函数以便复用）
async function handleToolCall(request: CallToolRequest) {
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

      case "confluence_download_attachment": {
        if (!args.downloadUrl) throw new Error("必须提供 downloadUrl");

        const downloadUrl = String(args.downloadUrl);

        // 确定文件名
        let filename = args.filename as string | undefined;
        if (!filename) {
          // 从 URL 中提取文件名
          const urlParts = downloadUrl.split("/");
          filename = urlParts[urlParts.length - 1] || "attachment";
          // 解码 URL 编码的文件名
          filename = decodeURIComponent(filename);
        }

        // 确定保存目录
        const outputDir = (args.outputDir as string | undefined) || path.join(os.homedir(), "Downloads");

        // 确保目录存在
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }

        // 完整的文件路径
        const filePath = path.join(outputDir, filename);

        // 下载附件
        const arrayBuffer = await downloadAttachment(downloadUrl);

        // 保存到文件
        fs.writeFileSync(filePath, Buffer.from(arrayBuffer));

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 附件下载成功！\n\n` +
                `文件名: ${filename}\n` +
                `保存路径: ${filePath}\n` +
                `文件大小: ${(arrayBuffer.byteLength / 1024).toFixed(2)} KB`,
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

      case "confluence_get_page_attachments": {
        if (!args.pageId) throw new Error("必须提供 pageId");

        const attachments = await getPageAttachments(String(args.pageId), (args.limit as number) || 100);

        const formatted = attachments.map((a) => ({
          id: a.id,
          title: a.title,
          mediaType: a.mediaType,
          fileSize: a.fileSize,
          download: a._links.download ? `${CONF_BASE_URL}${a._links.download}` : undefined,
          webui: a._links.webui ? `${CONF_BASE_URL}${a._links.webui}` : undefined,
        }));

        return {
          content: [
            {
              type: "text",
              text:
                attachments.length > 0
                  ? `共找到 ${attachments.length} 个附件：\n\n${JSON.stringify(formatted, null, 2)}`
                  : "该页面暂无附件",
            },
          ],
        };
      }

      case "confluence_copy_page": {
        if (!args.sourcePageId) throw new Error("必须提供 sourcePageId");
        if (!args.newTitle) throw new Error("必须提供 newTitle");

        // 获取源页面信息
        const sourcePage = await getPageById(String(args.sourcePageId));
        const targetSpace = (args.targetSpace as string | undefined) || sourcePage.space.key;
        const copyAttachments = args.copyAttachments !== false; // 默认为 true

        // 解析父页面
        const parentResolve = await resolveParentIdForCreate({
          space: targetSpace,
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

        // 创建新页面（复制内容）
        const content = sourcePage.body?.storage?.value || "";
        const newPage = await createPage(targetSpace, String(args.newTitle), content, parentResolve.parentId);

        let attachmentResult = { success: 0, failed: 0, details: [] as Array<{ name: string; success: boolean; error?: string }> };

        // 复制附件
        if (copyAttachments) {
          attachmentResult = await copyPageAttachments(String(args.sourcePageId), newPage.id);
        }

        const attachmentMsg = copyAttachments
          ? `\n附件复制：成功 ${attachmentResult.success} 个，失败 ${attachmentResult.failed} 个` +
            (attachmentResult.failed > 0
              ? `\n失败详情：${attachmentResult.details
                  .filter((d) => !d.success)
                  .map((d) => `${d.name}: ${d.error}`)
                  .join("; ")}`
              : "")
          : "\n附件复制：已跳过";

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 页面复制成功！\n\n` +
                `源页面: ${sourcePage.title} (ID: ${sourcePage.id})\n` +
                `新页面: ${newPage.title} (ID: ${newPage.id})\n` +
                `URL: ${CONF_BASE_URL}${newPage._links.webui}` +
                attachmentMsg,
            },
          ],
        };
      }

      case "confluence_render_mermaid": {
        if (!args.mermaidCode) throw new Error("必须提供 mermaidCode");
        if (!args.pageId) throw new Error("必须提供 pageId");

        const fileName = (args.filename as string) || "mermaid-diagram.png";

        // 1. 渲染 Mermaid 为 PNG
        const { imageBuffer, url: mermaidUrl } = await renderMermaidToImage(
          String(args.mermaidCode),
          {
            theme: (args.theme as string | undefined) ?? undefined,
            bgColor: (args.bgColor as string | undefined) ?? undefined,
            width: (args.width as number | undefined) ?? undefined,
            height: (args.height as number | undefined) ?? undefined,
          }
        );

        // 2. 上传附件
        const uploadResult = await uploadAttachmentToPage({
          pageId: String(args.pageId),
          fileName,
          fileArrayBuffer: imageBuffer,
          comment: "Mermaid diagram rendered via mermaid.ink",
        });

        const imageHtml = `<ac:image><ri:attachment ri:filename="${fileName}" /></ac:image>`;

        // 3. 如果需要嵌入页面
        if (args.embedInPage === true) {
          const page = await getPageById(String(args.pageId));
          const currentBody = page.body?.storage?.value || "";
          const newBody = currentBody + imageHtml;
          await updatePage(page, newBody);
        }

        return {
          content: [
            {
              type: "text",
              text:
                `✅ Mermaid 图表渲染并上传成功！\n\n` +
                `页面ID: ${String(args.pageId)}\n` +
                (uploadResult.id ? `附件ID: ${uploadResult.id}\n` : "") +
                `文件名: ${fileName}\n` +
                (uploadResult.download ? `下载: ${uploadResult.download}\n` : "") +
                `渲染URL: ${mermaidUrl}\n` +
                (args.embedInPage ? `已嵌入页面\n` : "") +
                `\n嵌入页面的宏代码:\n${imageHtml}`,
            },
          ],
        };
      }

      case "confluence_fix_code_macros": {
        if (!args.pageId) throw new Error("必须提供 pageId");

        const page = await getPageById(String(args.pageId));
        const originalBody = page.body?.storage?.value || "";
        const fixedBody = sanitizeCodeMacros(originalBody);

        if (fixedBody === originalBody) {
          return {
            content: [
              {
                type: "text",
                text: `页面 ${page.title} (ID: ${page.id}) 中未发现需要修复的代码宏 language 参数。`,
              },
            ],
          };
        }

        await updatePage(page, fixedBody);
        return {
          content: [
            {
              type: "text",
              text:
                `✅ 页面代码宏已修复！\n\n` +
                `页面: ${page.title} (ID: ${page.id})\n` +
                `URL: ${CONF_BASE_URL}${page._links.webui}`,
            },
          ],
        };
      }

      case "confluence_move_page": {
        if (!args.pageId) throw new Error("必须提供 pageId");
        if (!args.targetPageId) throw new Error("必须提供 targetPageId");

        const position = (args.position as "append" | "above" | "below") || "append";

        await movePage(
          String(args.pageId),
          position,
          String(args.targetPageId)
        );

        const positionDesc =
          position === "append"
            ? `目标页面 ${args.targetPageId} 的子页面`
            : position === "above"
              ? `目标页面 ${args.targetPageId} 的前面`
              : `目标页面 ${args.targetPageId} 的后面`;

        return {
          content: [
            {
              type: "text",
              text: `✅ 页面 ${args.pageId} 已成功移动到${positionDesc}。`,
            },
          ],
        };
      }

      case "confluence_sort_child_pages": {
        if (!args.parentId) throw new Error("必须提供 parentId");

        const sortBy = (args.sortBy as "title" | "custom") || "title";
        const order = (args.order as "asc" | "desc") || "asc";
        const pageIds = args.pageIds as string[] | undefined;

        const result = await sortChildPages(
          String(args.parentId),
          sortBy,
          order,
          pageIds
        );

        const listing = result.sorted
          .map((p, i) => `${i + 1}. ${p.title} (ID: ${p.id})`)
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                `✅ 子页面排序完成！共 ${result.sorted.length} 个页面。\n\n` +
                `排序方式: ${sortBy === "title" ? `按标题${order === "desc" ? "降序" : "升序"}` : "自定义顺序"}\n\n` +
                `排序结果:\n${listing}`,
            },
          ],
        };
      }

      case "confluence_get_page_versions": {
        if (!CONF_BASE_URL) throw new Error("缺少环境变量 CONF_BASE_URL");
        if (!args.pageId) throw new Error("必须提供 pageId");

        const versionsResult = await getPageVersions(
          String(args.pageId),
          (args.limit as number) || 20,
          (args.start as number) || 0
        );

        const versionListing = versionsResult.versions
          .map(
            (v) =>
              `v${v.number} | ${v.by.displayName || v.by.username || "未知"} | ${v.when}${v.message ? ` | ${v.message}` : ""}${v.minorEdit ? " (小修改)" : ""}\n   链接: ${v.versionUrl}`
          )
          .join("\n");

        return {
          content: [
            {
              type: "text",
              text:
                `📋 页面「${versionsResult.pageTitle}」版本列表（共 ${versionsResult.totalCount} 个版本）\n\n` +
                versionListing,
            },
          ],
        };
      }

      case "confluence_get_page_version_detail": {
        if (!CONF_BASE_URL) throw new Error("缺少环境变量 CONF_BASE_URL");
        if (!args.pageId) throw new Error("必须提供 pageId");
        if (!args.versionNumber) throw new Error("必须提供 versionNumber");

        const detail = await getPageVersionDetail(
          String(args.pageId),
          Number(args.versionNumber)
        );

        return {
          content: [
            {
              type: "text",
              text:
                `📄 页面「${detail.title}」版本 ${detail.versionNumber} 详情\n\n` +
                `作者: ${detail.by.displayName || detail.by.username || "未知"}\n` +
                `时间: ${detail.when}\n` +
                `备注: ${detail.message || "无"}\n` +
                `链接: ${detail.versionUrl}\n\n` +
                `--- 内容 ---\n${detail.content}`,
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
}

async function main(): Promise<void> {
  const { mode, port } = parseArgs();

  if (mode === "http") {
    await startHttpServer(port);
  } else {
    await startStdioServer();
  }
}

main().catch((error) => {
  console.error("服务器错误:", error);
  process.exit(1);
});


