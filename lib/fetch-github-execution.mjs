/* Read-only GitHub customer connector for Fetch. */
import { getProviderConnection } from "./fetch-provider-connections.mjs";

const SUPABASE_URL =
  process.env.VITE_SUPABASE_URL ||
  "https://skfxzagxlxputwpwxwbe.supabase.co";
const SUPABASE_KEY =
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  process.env.SUPABASE_SERVICE_ROLE;
const GITHUB_API = "https://api.github.com";

function clean(value) {
  return String(value ?? "").trim();
}

function lower(value) {
  return clean(value).toLowerCase();
}

function hasAny(value, terms) {
  const source = lower(value);
  return terms.some((term) => source.includes(term));
}

export function isGitHubRequest(text = "") {
  const value = lower(text);
  if (!value) return false;

  return (
    value.includes("github.com/") ||
    value.includes("github") ||
    hasAny(value, [
      "my repositories",
      "my repos",
      "all repositories",
      "all repos",
      "list repositories",
      "list repos",
      "show repositories",
      "show repos",
      "how many repositories",
      "how many repos",
      "repository count",
      "repo count",
    ]) ||
    (
      hasAny(value, ["repositories", "repos"]) &&
      hasAny(value, ["profile", "account", "github", "owned", "mine"])
    ) ||
    (
      hasAny(value, ["pull request", "pull requests", "prs", "issues", "commits"]) &&
      hasAny(value, ["github", "repository", "repo", "my"])
    )
  );
}

async function db(path) {
  if (!SUPABASE_KEY) {
    throw new Error("Supabase server key is not configured");
  }

  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/${path}`,
    {
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  const raw = await response.text();

  if (!response.ok) {
    throw new Error(
      `Supabase ${response.status}: ${raw.slice(0, 200)}`
    );
  }

  return raw ? JSON.parse(raw) : [];
}

async function resolveConnection({
  conversationId,
  customerId,
}) {
  if (conversationId) {
    const direct = await getProviderConnection({
      conversationId,
      customerId,
      providerId: "github",
    });

    if (direct?.access_token) {
      return direct;
    }
  }

  if (!customerId) {
    return null;
  }

  try {
    const rows = await db(
      "fetch_conversation_context?customer_id=eq." +
        encodeURIComponent(customerId) +
        "&select=conversation_id,updated_at&order=updated_at.desc&limit=30"
    );

    for (const row of Array.isArray(rows) ? rows : []) {
      const id = clean(row?.conversation_id);

      if (!id || id === conversationId) {
        continue;
      }

      const connection = await getProviderConnection({
        conversationId: id,
        customerId,
        providerId: "github",
      });

      if (connection?.access_token) {
        return connection;
      }
    }
  } catch (error) {
    console.warn(
      "FETCH GITHUB CROSS-CHANNEL LOOKUP:",
      error?.message || error
    );
  }

  return null;
}

async function githubFetch(path, token) {
  const response = await fetch(GITHUB_API + path, {
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "Fetch-Personal-Agent",
    },
  });

  const raw = await response.text();

  let data;

  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    data = raw;
  }

  if (!response.ok) {
    const message =
      data?.message ||
      `GitHub API returned HTTP ${response.status}`;

    const error = new Error(message);
    error.status = response.status;
    throw error;
  }

  return {
    data,
    headers: response.headers,
  };
}

function parseGitHubRepoUrl(text) {
  const value = clean(text);

  if (!value.includes("github.com/")) {
    return null;
  }

  try {
    const url = new URL(
      value.startsWith("http")
        ? value
        : "https://" + value
    );

    if (
      url.hostname !== "github.com" &&
      url.hostname !== "www.github.com"
    ) {
      return null;
    }

    const parts = url.pathname
      .split("/")
      .map((part) => part.trim())
      .filter(Boolean);

    if (parts.length < 2) {
      return null;
    }

    const owner = parts[0];
    const repo = parts[1].replace(/\.git$/i, "");

    const reserved = [
      "issues",
      "pulls",
      "projects",
      "settings",
      "actions",
      "discussions",
      "sponsors",
      "packages",
    ];

    if (reserved.includes(repo.toLowerCase())) {
      return null;
    }

    return {
      owner,
      repo,
    };
  } catch {
    return null;
  }
}

function repoDescription(repo) {
  return [
    `**${repo.full_name}**`,
    repo.description || "No description is set.",
    `• Visibility: ${repo.private ? "Private" : "Public"}`,
    `• Default branch: ${repo.default_branch || "unknown"}`,
    `• Language: ${repo.language || "Not specified"}`,
    `• Stars: ${Number(repo.stargazers_count || 0)} · Forks: ${Number(repo.forks_count || 0)}`,
    `• Updated: ${repo.updated_at ? new Date(repo.updated_at).toLocaleDateString("en-IN") : "unknown"}`,
    `• Link: ${repo.html_url}`,
  ].join("\n");
}

async function countOwnedRepositories(token) {
  const repos = [];

  for (let page = 1; page <= 100; page += 1) {
    const { data } = await githubFetch(
      `/user/repos?visibility=all&affiliation=owner&per_page=100&page=${page}&sort=updated`,
      token
    );

    if (!Array.isArray(data)) {
      throw new Error(
        "GitHub returned an unexpected repository list."
      );
    }

    repos.push(...data);

    if (data.length < 100) {
      break;
    }
  }

  return repos;
}

async function readRepository({ owner, repo }, token) {
  const { data } = await githubFetch(
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`,
    token
  );

  let readmeText = "";

  try {
    const readme = await githubFetch(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/readme`,
      token
    );

    const encoded = readme.data?.content;

    if (encoded) {
      readmeText = Buffer.from(
        encoded.replace(/\s/g, ""),
        "base64"
      ).toString("utf8");
    }
  } catch (error) {
    if (error?.status !== 404) {
      console.warn(
        "FETCH GITHUB README LOOKUP:",
        error?.message || error
      );
    }
  }

  const headings = readmeText
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("<!--"))
    .slice(0, 28)
    .join("\n")
    .slice(0, 6500);

  return {
    result:
      repoDescription(data) +
      (
        headings
          ? `\n\n**README overview**\n${headings}`
          : "\n\nNo README was available to summarize."
      ),
    metadata: {
      owner,
      repo,
      html_url: data.html_url,
    },
  };
}

function isGitHubStatusRequest(value) {
  const source = lower(value);
  return (
    (
      source.includes("is github connected") ||
      source.includes("is github connect") ||
      source.includes("github connected") ||
      source.includes("github connection") ||
      source.includes("github account connected") ||
      source.includes("github linked") ||
      source.includes("github link")
    ) &&
    !source.includes("how many") &&
    !source.includes("list") &&
    !source.includes("show my repositories")
  );
}

function isRepositoryCountRequest(value) {
  const source = lower(value);

  return (
    (
      source.includes("how many") ||
      source.includes("count") ||
      source.includes("number of")
    ) &&
    (
      source.includes("repository") ||
      source.includes("repo")
    )
  );
}

function isRepositoryListRequest(value) {
  const source = lower(value);

  return (
    (
      source.includes("list") ||
      source.includes("show") ||
      source.includes("display")
    ) &&
    (
      source.includes("repository") ||
      source.includes("repo")
    )
  ) ||
    source.includes("my repositories") ||
    source.includes("my repos");
}

export async function executeGitHubRequest({
  text,
  conversationId = null,
  customerId = null,
} = {}) {
  const request = clean(text);

  const connection = await resolveConnection({
    conversationId,
    customerId,
  });

  if (!connection?.access_token) {
    return {
      success: false,
      status: "github_not_connected",
      execution_type: "github_connector",
      message:
        "GitHub isn’t connected to this Fetch conversation yet. Open Fetch Connectors and connect GitHub, then send your request again.",
    };
  }

  try {
    const { data: me } = await githubFetch(
      "/user",
      connection.access_token
    );

    if (isGitHubStatusRequest(request)) {
      const message =
        `Yes, GitHub is connected to **${me.login}**. I can read your repositories, issues, pull requests and code, and help you work with them through Fetch.`;
      return {
        success: true,
        status: "completed",
        execution_type: "github_connector",
        message,
        result: message,
        metadata: {
          github_login: me.login,
          connected: true,
          provider: "github",
        },
      };
    }

    const repoUrl = parseGitHubRepoUrl(request);

    if (repoUrl) {
      const read = await readRepository(
        repoUrl,
        connection.access_token
      );

      return {
        success: true,
        status: "completed",
        execution_type: "github_connector",
        message:
          `Here’s what I found on GitHub, ${me.login}:\n\n${read.result}`,
        result: read.result,
        metadata: {
          github_login: me.login,
          ...read.metadata,
        },
      };
    }

    if (isRepositoryCountRequest(request)) {
      const repos = await countOwnedRepositories(
        connection.access_token
      );

      const visible = repos
        .slice(0, 8)
        .map(
          (repo) =>
            `• ${repo.full_name}${
              repo.private ? " (private)" : ""
            }`
        );

      const message = [
        `You have **${repos.length} repositories** owned by ${me.login} on GitHub.`,
        repos.length
          ? `\nRecently updated repositories:\n${visible.join("\n")}`
          : "",
        repos.length > 8
          ? `\n…and ${repos.length - 8} more.`
          : "",
        `\nProfile: https://github.com/${me.login}`,
      ].join("");

      return {
        success: true,
        status: "completed",
        execution_type: "github_connector",
        message,
        result: message,
        metadata: {
          github_login: me.login,
          repository_count: repos.length,
        },
      };
    }

    if (isRepositoryListRequest(request)) {
      const repos = await countOwnedRepositories(
        connection.access_token
      );

      const message = repos.length
        ? `You have **${repos.length} repositories** owned by ${me.login}:\n\n` +
          repos
            .slice(0, 25)
            .map(
              (repo) =>
                `• ${repo.full_name}${
                  repo.private ? " (private)" : ""
                } — ${repo.html_url}`
            )
            .join("\n") +
          (
            repos.length > 25
              ? `\n\n…and ${repos.length - 25} more.`
              : ""
          )
        : `I couldn’t find any repositories owned by ${me.login}.`;

      return {
        success: true,
        status: "completed",
        execution_type: "github_connector",
        message,
        result: message,
        metadata: {
          github_login: me.login,
          repository_count: repos.length,
        },
      };
    }

    const { data: repos } = await githubFetch(
      "/user/repos?visibility=all&affiliation=owner&per_page=10&sort=updated",
      connection.access_token
    );

    const message =
      `GitHub is connected as **${me.login}**. I can read repository details and README files, count or list your repositories, and inspect repository issues and pull requests.\n\nYour recently updated repositories:\n` +
      (
        Array.isArray(repos) && repos.length
          ? repos
              .slice(0, 8)
              .map(
                (repo) =>
                  `• ${repo.full_name} — ${repo.html_url}`
              )
              .join("\n")
          : "No owned repositories were returned."
      );

    return {
      success: true,
      status: "completed",
      execution_type: "github_connector",
      message,
      result: message,
      metadata: {
        github_login: me.login,
      },
    };
  } catch (error) {
    console.error(
      "FETCH GITHUB EXECUTION ERROR:",
      error?.status || "",
      error?.message || error
    );

    const message =
      error?.status === 401
        ? "GitHub’s connection has expired or been revoked. Please reconnect GitHub in Fetch Connectors and try again."
        : error?.status === 403
          ? "GitHub denied this request. Check that Fetch has permission to read the requested repository."
          : "I connected to GitHub, but couldn’t complete that request right now. Please try again.";

    return {
      success: false,
      status: "github_execution_failed",
      execution_type: "github_connector",
      message,
    };
  }
}
