export interface Agent {
  id: string;
  name: string;
  description: string;
  instructions: string;
  model: string;
  tools: string[];
  createdAt: string;
}
