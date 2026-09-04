#!/usr/bin/env bash
# sync-ens-docs.sh — 把 ENS 官方文档拉到本地,并报告哪些页面变了
#
#   pnpm docs:ens            拉最新,报告 ensv2/ 下的变更
#   pnpm docs:ens --check    只报告,不拉取(离线可用)
#   pnpm docs:ens --addresses 顺带刷新 Sepolia 部署地址表
#
# 为什么是「gitignore 的克隆 + 少量提交的摘录」,而不是把上游文档整份提交进来:
#
#   上游是 CC0,复制没有法律障碍。问题是**陈旧**:一份提交进仓库的副本不会自己更新,
#   而它看起来和上游一模一样,下一个人不会去核对日期。三个月后它开始撒谎,且没有任何
#   机制会喊。所以整份文档走 gitignore 的克隆(靠这个脚本刷新),
#   **只有我们的方案实际依赖的那几条事实**才进 docs/reference/ENSV2-UPSTREAM.md,
#   在那里带着来源 URL 和抓取日期,过期时看得见。
set -euo pipefail

REPO_URL="https://github.com/ensdomains/docs.git"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLONE="$ROOT/vendor/ens-docs"
STAMP="$ROOT/vendor/.ens-docs-synced-sha"

WATCH_PATHS=(src/pages/ensv2 src/pages/web/ensv2-readiness.mdx src/pages/resolution src/pages/resolvers)

do_fetch=1
do_addresses=0
for arg in "$@"; do
  case "$arg" in
    --check)     do_fetch=0 ;;
    --addresses) do_addresses=1 ;;
    -h|--help)   sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

if [ ! -d "$CLONE/.git" ]; then
  if [ "$do_fetch" -eq 0 ]; then
    echo "ENS_DOCS: no local clone at vendor/ens-docs — run without --check first" >&2
    exit 1
  fi
  echo "ENS_DOCS: cloning $REPO_URL → vendor/ens-docs (shallow)"
  git clone --depth 1 "$REPO_URL" "$CLONE"
  echo "ENS_DOCS: first sync — nothing to diff against yet"
  # 不在这里 exit:首次运行如果带了 --addresses,地址表也该一并生成,
  # 否则「第一次跑」和「第二次跑」的产物不一样,而没人会预期这件事。
  do_fetch=0   # 刚 clone 完就是最新的,不必再 fetch 一次
fi

prev="$(cat "$STAMP" 2>/dev/null || true)"

# 上游默认分支现在是 master,但别写死 —— 上游改名时这个脚本应该跟着走,
# 而不是拿 "couldn't find remote ref main" 把同步卡死。
default_branch="$(git -C "$CLONE" symbolic-ref --short refs/remotes/origin/HEAD 2>/dev/null | sed 's|^origin/||')"
default_branch="${default_branch:-master}"

if [ "$do_fetch" -eq 1 ]; then
  git -C "$CLONE" fetch --depth 1 origin "$default_branch" --quiet
  git -C "$CLONE" reset --hard "origin/$default_branch" --quiet
fi

now="$(git -C "$CLONE" rev-parse HEAD)"
when="$(git -C "$CLONE" log -1 --format=%cI)"

echo "ENS_DOCS: upstream $default_branch @ $now ($when)"

if [ -z "$prev" ]; then
  echo "ENS_DOCS: no previous sync recorded — diff skipped"
elif [ "$prev" = "$now" ]; then
  echo "ENS_DOCS: unchanged since last sync"
else
  # 浅克隆里 prev 这个对象通常已经不在了(--depth 1 + reset --hard 会丢历史)。
  # 拿不到就照实说「无法 diff」,不要假装没有变更 —— 静默的「没变化」比报错危险得多。
  if git -C "$CLONE" cat-file -e "$prev^{commit}" 2>/dev/null; then
    echo "ENS_DOCS: changed since $prev:"
    git -C "$CLONE" diff --name-status "$prev" "$now" -- "${WATCH_PATHS[@]}" | sed 's/^/  /'
  else
    echo "ENS_DOCS: upstream moved $prev → $now, but the old commit is not in this shallow"
    echo "ENS_DOCS: clone, so a file-level diff is NOT available. Treat the watched paths as"
    echo "ENS_DOCS: possibly changed:"
    printf '  %s\n' "${WATCH_PATHS[@]}"
  fi
fi

echo "$now" > "$STAMP"

if [ "$do_addresses" -eq 1 ]; then
  # 地址表不在 docs 仓库里:它在 build 时从 contracts-v2 的一个**钉住的 commit** 拉取。
  # 那个 SHA 写在 docs 仓库的 scripts/ensv2-deployments.ts 里,所以从那里读,而不是写死。
  pin="$(grep -oE "CONTRACTS_V2_COMMIT = '[0-9a-f]{40}'" "$CLONE/scripts/ensv2-deployments.ts" \
         | grep -oE '[0-9a-f]{40}' || true)"
  if [ -z "$pin" ]; then
    echo "ENS_DOCS: could not read CONTRACTS_V2_COMMIT from the docs repo — address refresh skipped" >&2
    exit 1
  fi
  out="$ROOT/docs/reference/ensv2-deployments-sepolia.md"
  mkdir -p "$(dirname "$out")"
  {
    echo "<!-- 由 scripts/sync-ens-docs.sh --addresses 生成,请勿手改 -->"
    echo "<!-- 来源: ensdomains/contracts-v2 @ $pin (docs 仓库 $now 钉住的那个 commit) -->"
    echo "<!-- 抓取于: $(date -u +%Y-%m-%dT%H:%M:%SZ) -->"
    echo
    curl -fsSL "https://raw.githubusercontent.com/ensdomains/contracts-v2/$pin/contracts/docs/addresses/sepolia.md"
  } > "$out"
  echo "ENS_DOCS: wrote ${out#$ROOT/} (contracts-v2 @ ${pin:0:8})"
fi
