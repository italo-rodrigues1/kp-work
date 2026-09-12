# PROJETO

- Aplicação de chat, flow e agentes ai, expert em tres pilares: conversação com arquivos, geração de arquivo e auxiliador em fluxos de trabalhos, portanto sendo focado em empresas.

## Requisitos Funcionais

- Conseguir criar agentes especialistas.
- Conseguir criar flows de trabalhos, programar crons/routinas para o flow ser rodado, utilizar agentes dentro do flow.
- Conseguir conversar com documentos(pdf,docx,xlsx,xls,csv,txt,md e xml) e medias(audio e video) dentro do chat.
- Deve ser possivel fazer login com usuário e senha
- Teve ser possivel criar/gerar arquivos pdf,docx,xlsx,xls,csv,txt,md e xml pelo agentes ou aplicação, diante a solicitação do usuário
- Conseguir criar modelos e provides dinamicos para serem utilizados na aplicação.
- Conseguir mandar audio no chat(utilizar o real time transcription).
- Deve ser possivel utilizar e criar workspaces para separação de informações/contexto

## Requisitos Não Funcionais

- O sistema deve suportar 5.000 usuário em simultaneos.
- O chat precisa suportar uma conversação com 100 arquivos.
- 

## Casos de Usos

1 – Análise Tributária de Documentos
Usuário (auditor/tributarista) sobe várias notas fiscais, SPED, contratos e planilhas.
Conversa: “Identifique inconsistências de alíquota de ICMS entre as NFs e a planilha de apuração. Gere um relatório em DOCX com as divergências e uma planilha XLSX consolidada.”
2 – Due Diligence / Análise de Contratos
Usuário sobe 15–40 contratos + aditivos + planilha de obrigações.
Conversa com agente especialista “Contratos”:
“Compare as cláusulas de rescisão e multas. Liste riscos e gere um parecer em PDF + planilha de obrigações.”
3 – Preparação de Parecer / Relatório Contábil-Fiscal
Usuário sobe balancetes, DRE, notas explicativas e legislação.
Pede: “Elabore um parecer técnico sobre a aplicabilidade do regime X e gere o documento em DOCX formatado + planilha de cálculos.”
4 – Transcrição + Análise de Reunião
Usuário envia áudio/vídeo da reunião com cliente + documentos discutidos.
Sistema transcreve, cruza com os arquivos e gera ata + lista de ações em DOCX/XLSX.
5 – Workspace de Projeto
Consultor cria um workspace “Cliente ABC – Revisão 2025”, sobe todos os arquivos do cliente, conversa ao longo de semanas com o mesmo contexto isolado e gera os entregáveis finais.
6- Juntar informações da web + base de conhecimento
Usuário enviou uma base financeira + informação da web.
