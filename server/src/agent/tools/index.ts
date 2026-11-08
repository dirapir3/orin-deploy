import { browserTools } from '../browser.js';
import { extraTools } from './extra.js';
import { ToolRegistry, type ToolDef } from './types.js';
import { webSearchTool, fetchPageTool } from './web.js';
import {
  rememberTool,
  recallTool,
  forgetTool,
  createNoteTool,
  updateNoteTool,
  listNotesTool,
  readNoteTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
} from './personal.js';
import { calculatorTool, dateTimeTool } from './utility.js';
import { generateImageTool } from './image.js';
import { createTaskTool, deepResearchTool, taskStatusTool, addToTaskTool, saveSkillTool, runSkillTool, listSkillsTool, createScheduleTool, deleteScheduleTool } from './tasks.js';
import { runCodeTool, browseTool } from './adapters.js';
import { connectorTools } from '../connectors.js';
import { sandboxTools } from './sandbox.js';
import { uploadTools } from './uploads.js';
import { reviewDesignTool } from './review.js';
import { learnLessonTool } from './learn.js';
import { connectToolServerTool, forgetKnowHowTool, recallKnowHowTool, rememberKnowHowTool, studySourceTool, toolServersTool, trialProjectTool, useToolServerTool } from './knowledge.js';
import { designKitTool } from './design.js';
import { compareToReferenceTool, studyReferenceTool } from './reference.js';
import { designSpecTool, matchDesignTool } from './designFile.js';
import { sandboxBrowserTool, sandboxEditFileTool, sandboxJobTool, sandboxLiveViewTool } from './computer.js';
import { codingTools } from './coding.js';
import { codeAuditTool } from './audit.js';
import { gitTools } from './git.js';

export const ALL_TOOLS: ToolDef[] = [
  webSearchTool,
  fetchPageTool,
  rememberTool,
  recallTool,
  forgetTool,
  createNoteTool,
  updateNoteTool,
  listNotesTool,
  readNoteTool,
  createReminderTool,
  listRemindersTool,
  cancelReminderTool,
  calculatorTool,
  dateTimeTool,
  generateImageTool,
  createTaskTool,
  deepResearchTool,
  taskStatusTool,
  addToTaskTool,
  saveSkillTool,
  runSkillTool,
  listSkillsTool,
  createScheduleTool,
  deleteScheduleTool,
  runCodeTool,
  browseTool,
  ...browserTools,
  ...extraTools,
  ...connectorTools,
  ...sandboxTools,
  ...uploadTools,
  reviewDesignTool,
  learnLessonTool,
  rememberKnowHowTool,
  recallKnowHowTool,
  forgetKnowHowTool,
  studySourceTool,
  connectToolServerTool,
  useToolServerTool,
  toolServersTool,
  trialProjectTool,
  designKitTool,
  studyReferenceTool,
  compareToReferenceTool,
  designSpecTool,
  matchDesignTool,
  sandboxEditFileTool,
  sandboxJobTool,
  sandboxBrowserTool,
  sandboxLiveViewTool,
  ...codingTools,
  codeAuditTool,
  ...gitTools,
];

export function buildToolRegistry(extra: ToolDef[] = []): ToolRegistry {
  return new ToolRegistry([...ALL_TOOLS, ...extra]);
}
