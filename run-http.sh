#!/bin/bash

# 要释放的端口
PORT=4173

echo "检查端口 $PORT 是否被占用..."

# 查找占用端口的进程 PID
PID=$(lsof -t -i:$PORT)

# 如果找到 PID，就杀掉
if [ -n "$PID" ]; then
  echo "找到占用进程 PID: $PID，正在关闭..."
  kill -9 $PID
  sleep 1
  echo "端口 $PORT 已释放"
else
  echo "端口 $PORT 未被占用"
fi

echo "启动开发服务..."
pnpm run dev
