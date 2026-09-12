export class CreateAgentDto {
  name?: string;
  description?: string;
  instructions?: string;
  model?: string;
  tools?: string[];
}
