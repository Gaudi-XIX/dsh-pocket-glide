// GENERATED FILE — DO NOT EDIT BY HAND.
// Regenerate with:  node tools/sync-step-process.mjs [path\to\app.asar]
// Source: D:\DSH\resources\app.asar  (dsh 0.2.0-rc.2, client.js sha256:a33cbb8130b6)
// Extracted at: 2026-10-08T07:52:40.503Z
// Namespaces (verbatim, zh then en): message.stepProcess.* / message.turnProcess.* / settings.transcript.*
// The tool-name -> category mapping is intentionally NOT generated; it stays a
// verbatim port in lib/constants.js with its own host-wording tests.

export const STEP_PROCESS_LABELS = {
  "zh": {
    "message.stepProcess.thinking": "正在分析请求",
    "message.stepProcess.read": "正在读取文件",
    "message.stepProcess.readImage": "正在读取图片",
    "message.stepProcess.write": "正在写入文件",
    "message.stepProcess.search": "正在搜索代码",
    "message.stepProcess.edit": "正在编辑文件",
    "message.stepProcess.commands": "正在运行命令",
    "message.stepProcess.code": "正在运行代码",
    "message.stepProcess.webSearch": "正在搜索网页",
    "message.stepProcess.webFetch": "正在访问网页",
    "message.stepProcess.subagents": "正在协调子智能体",
    "message.stepProcess.plan": "正在更新计划",
    "message.stepProcess.questions": "等待你的操作",
    "message.stepProcess.tools": "正在调用工具",
    "message.stepProcess.prepare.read": "准备读取文件",
    "message.stepProcess.prepare.readImage": "准备读取图片",
    "message.stepProcess.prepare.write": "准备写入文件",
    "message.stepProcess.prepare.search": "准备搜索代码",
    "message.stepProcess.prepare.edit": "准备编辑文件",
    "message.stepProcess.prepare.commands": "准备运行命令",
    "message.stepProcess.prepare.code": "准备运行代码",
    "message.stepProcess.prepare.webSearch": "准备搜索网页",
    "message.stepProcess.prepare.webFetch": "准备访问网页",
    "message.stepProcess.prepare.subagents": "准备协调子智能体",
    "message.stepProcess.prepare.plan": "准备更新计划",
    "message.stepProcess.prepare.questions": "准备提问",
    "message.stepProcess.prepare.tools": "准备调用工具",
    "message.stepProcess.done.thinking": "已完成分析",
    "message.stepProcess.done.read": "已读取文件",
    "message.stepProcess.done.readImage": "已读取图片",
    "message.stepProcess.done.write": "已写入文件",
    "message.stepProcess.done.search": "已搜索代码",
    "message.stepProcess.done.edit": "修改了文件",
    "message.stepProcess.done.commands": "执行了命令",
    "message.stepProcess.done.code": "运行了代码",
    "message.stepProcess.done.webSearch": "已搜索网页",
    "message.stepProcess.done.webFetch": "已访问网页",
    "message.stepProcess.done.subagents": "已协调子智能体",
    "message.stepProcess.done.plan": "更新了计划",
    "message.stepProcess.done.questions": "向用户提出了问题",
    "message.stepProcess.done.tools": "已调用工具",
    "message.stepProcess.joinTwo": "{first}并{second}",
    "message.stepProcess.comma": "，",
    "message.stepProcess.sharedPrefix": "已",
    "message.stepProcess.more": "{title}等"
  },
  "en": {
    "message.stepProcess.thinking": "Analyzing the request",
    "message.stepProcess.read": "Reading files",
    "message.stepProcess.readImage": "Reading images",
    "message.stepProcess.write": "Writing files",
    "message.stepProcess.search": "Searching code",
    "message.stepProcess.edit": "Editing files",
    "message.stepProcess.commands": "Running commands",
    "message.stepProcess.code": "Running code",
    "message.stepProcess.webSearch": "Searching the web",
    "message.stepProcess.webFetch": "Visiting web pages",
    "message.stepProcess.subagents": "Coordinating subagents",
    "message.stepProcess.plan": "Updating the plan",
    "message.stepProcess.questions": "Waiting for your action",
    "message.stepProcess.tools": "Calling tools",
    "message.stepProcess.prepare.read": "Preparing to read files",
    "message.stepProcess.prepare.readImage": "Preparing to read images",
    "message.stepProcess.prepare.write": "Preparing to write files",
    "message.stepProcess.prepare.search": "Preparing to search code",
    "message.stepProcess.prepare.edit": "Preparing to edit files",
    "message.stepProcess.prepare.commands": "Preparing to run commands",
    "message.stepProcess.prepare.code": "Preparing to run code",
    "message.stepProcess.prepare.webSearch": "Preparing to search the web",
    "message.stepProcess.prepare.webFetch": "Preparing to visit web pages",
    "message.stepProcess.prepare.subagents": "Preparing to coordinate subagents",
    "message.stepProcess.prepare.plan": "Preparing to update the plan",
    "message.stepProcess.prepare.questions": "Preparing questions",
    "message.stepProcess.prepare.tools": "Preparing tool calls",
    "message.stepProcess.done.thinking": "Analysis completed",
    "message.stepProcess.done.read": "Read files",
    "message.stepProcess.done.readImage": "Read images",
    "message.stepProcess.done.write": "Wrote files",
    "message.stepProcess.done.search": "Searched code",
    "message.stepProcess.done.edit": "Edited files",
    "message.stepProcess.done.commands": "Ran commands",
    "message.stepProcess.done.code": "Ran code",
    "message.stepProcess.done.webSearch": "Searched the web",
    "message.stepProcess.done.webFetch": "Visited web pages",
    "message.stepProcess.done.subagents": "Coordinated subagents",
    "message.stepProcess.done.plan": "Updated the plan",
    "message.stepProcess.done.questions": "Asked questions",
    "message.stepProcess.done.tools": "Called tools",
    "message.stepProcess.joinTwo": "{first} and {second}",
    "message.stepProcess.comma": ", ",
    "message.stepProcess.sharedPrefix": "",
    "message.stepProcess.more": "{title}, etc."
  }
}

export const TURN_PROCESS_LABELS = {
  "zh": {
    "message.turnProcess.worked": "已完成",
    "message.turnProcess.took": "已完成，用时 ",
    "message.turnProcess.failed": "处理失败",
    "message.turnProcess.toolCalls.one": "{count} 次工具调用",
    "message.turnProcess.toolCalls.other": "{count} 次工具调用",
    "message.turnProcess.messages.one": "{count} 条消息",
    "message.turnProcess.messages.other": "{count} 条消息",
    "message.turnProcess.subagents.one": "{count} 个 subagent",
    "message.turnProcess.subagents.other": "{count} 个 subagent",
    "message.turnProcess.thoughtForAWhile": "已思考",
    "message.turnProcess.separator": " · "
  },
  "en": {
    "message.turnProcess.worked": "Completed",
    "message.turnProcess.took": "Completed in ",
    "message.turnProcess.failed": "Failed",
    "message.turnProcess.toolCalls.one": "{count} tool call",
    "message.turnProcess.toolCalls.other": "{count} tool calls",
    "message.turnProcess.messages.one": "{count} message",
    "message.turnProcess.messages.other": "{count} messages",
    "message.turnProcess.subagents.one": "{count} subagent",
    "message.turnProcess.subagents.other": "{count} subagents",
    "message.turnProcess.thoughtForAWhile": "Thought for a while",
    "message.turnProcess.separator": " · "
  }
}

export const TRANSCRIPT_LABELS = {
  "zh": {
    "settings.transcript.title": "工作步骤展示",
    "settings.transcript.description": "选择希望看到多少工具调用细节",
    "settings.transcript.compact": "简洁",
    "settings.transcript.standard": "标准",
    "settings.transcript.detailed": "详细",
    "settings.transcript.verbose": "完全展开"
  },
  "en": {
    "settings.transcript.title": "Work details",
    "settings.transcript.description": "Choose how much detail to show for tool calls",
    "settings.transcript.compact": "Compact",
    "settings.transcript.standard": "Standard",
    "settings.transcript.detailed": "Detailed",
    "settings.transcript.verbose": "Verbose"
  }
}

export const GENERATED_FROM = {
  "asar": "D:\\DSH\\resources\\app.asar",
  "dshVersion": "0.2.0-rc.2",
  "clientHash": "a33cbb8130b6",
  "extractedAt": "2026-10-08T07:52:40.503Z"
}
