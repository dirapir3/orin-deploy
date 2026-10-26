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
import { createTaskTool, deepResearchTool, taskStatusTool, saveSkillTool, runSkillTool, listSkillsTool, createScheduleTool, deleteScheduleTool } from './tasks.js';
import { runCodeTool, browseTool } from './adapters.js';
import { connectorTools } from '../connectors.js';
import { sandboxTools } from './sandbox.js';
import { reviewDesignTool } from './review.js';
import { learnLessonTool } from './learn.js';
import { sandboxBrowserTool, sandboxEditFileTool, sandboxJobTool, sandboxLiveViewTool } from './computer.js';

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
  reviewDesignTool,
  learnLessonTool,
  sandboxEditFileTool,
  sandboxJobTool,
  sandboxBrowserTool,
  sandboxLiveViewTool,
];

export function buildToolRegistry(extra: ToolDef[] = []): ToolRegistry {
  return new ToolRegistry([...ALL_TOOLS, ...extra]);
}
