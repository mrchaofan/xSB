# @xsb/store

只追加的 JSONL 事件日志，外加一个让"多个文件一起改"变成原子操作的预写日志（WAL）。不依赖其他库，也不知道日志里记的是什么：Hub 的状态如何从日志折叠出来，是 `@xsb/hub` 的事。

## 使用

```ts
import { Store } from "@xsb/store";

const store = new Store("/path/to/.xsb"); // 所有文件名都相对这个目录
store.recover();                          // 启动时调用一次，在读任何状态之前

store.append("agents.jsonl", { op: "put", agent });   // 单文件：追加一行并落盘
store.append("log.jsonl", rec, false);                // 不强制落盘（如会话记录）

store.tx([                                            // 跨文件：全有或全无
  { file: "tasks.jsonl", rec: { op: "put", task } },
  { file: "mailbox.jsonl", rec: { op: "ack", id } },
]);

for (const rec of store.read("tasks.jsonl")) apply(rec);   // 重放

store.rewrite("memory.jsonl", compacted);             // 用压缩后的内容原子替换整个日志
```

## 保证

- **单文件修改**就是追加一行。崩溃留下的半行在下次打开时被截掉，读取时也会跳过：没写完就等于没发生。
- **跨文件修改**（`tx`，两条及以上）是 redo log：
  1. 把整组记录写进 `wal.jsonl` 并落盘；
  2. 逐条追加到各自的文件，每条带标记 `_tx: "<事务>:<序号>"`；
  3. 向 `wal.jsonl` 写 commit。

  `recover()` 找出有 begin 没有 commit 的事务，补写缺失的记录（靠 `_tx` 标记判断哪些已写），所以可以重复执行。begin 没落盘的事务等于没发生。
- 没有未完成事务时 WAL 没有用处：`recover()` 之后清空，运行中超过 1 MB 也清空。

读到的记录可能带 `_tx` 字段，使用方忽略它即可。

## 前提

- **单写者**：同一个目录只能有一个进程在写。xsb 里由 Hub 独占项目来保证（见 `@xsb/hub` 的 `daemon.ts`）。
- `tx` 是同步的，进程内事务不会交错。

## 测试

```bash
npm test -w @xsb/store
```

在事务的每一步用 `store.failpoint` 模拟崩溃，检查恢复后全有或全无、恢复可重复执行。
