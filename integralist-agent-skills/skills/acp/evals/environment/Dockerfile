FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash curl git procps ripgrep coreutils ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace
RUN git init --bare --initial-branch=main /workspace/work-repo-origin.git \
    && git init --initial-branch=main /workspace/work-repo \
    && cd /workspace/work-repo \
    && git config user.name "Eval Operator" \
    && git config user.email "eval@users.noreply.github.com" \
    && mkdir -p src scratch \
    && printf 'def parse(line: str) -> list[str]:\n    return line.split(",")\n' > src/parser.py \
    && git add src/parser.py \
    && git commit -m "feat(parser): initial comma splitter" \
    && git remote add origin /workspace/work-repo-origin.git \
    && git push -u origin main \
    && printf 'def parse(line: str) -> list[str]:\n    return [part.strip() for part in line.split(",") if part.strip()]\n' > src/parser.py \
    && printf 'local debug notes - keep unstaged\n' > scratch/debug.txt
