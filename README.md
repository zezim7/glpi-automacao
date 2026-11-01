# GLPI Planejador

Extensão para Chrome e Microsoft Edge que move automaticamente os chamados **Novo** para
**Em atendimento (planejado)** no GLPI, enquanto a lista de chamados filtrada por
"Status é Novo" estiver aberta.

Ela usa a própria tela do GLPI: marca os chamados Novo, abre **Ações > Atualizar >
Características - Status > Em atendimento (planejado)** e envia.

Testada no GLPI 10.0.28 e 11.0.12, com o GLPI em português.

## Instalação
1. Baixe ou clone este repositório numa pasta permanente.
2. Abra `chrome://extensions` (ou `edge://extensions`) e ative o **Modo do desenvolvedor**.
3. Clique em **Carregar sem compactação** e selecione a pasta do projeto.
4. No GLPI, abra a lista de chamados filtrada por "Status é Novo" (ou o quadro "Chamados novos").

## Segurança
- Só age na lista filtrada por "Status é Novo". Em qualquer outra lista (Todos, Solucionados,
  Fechados, lixeira) não marca, não envia e não recarrega nada.
- Só marca chamados com status Novo; se a lista tiver outro status, não faz nada.
- No máximo 2 tentativas por chamado, depois pausa 10 minutos.
- Só roda em páginas `.../front/ticket.php` e não tem acesso a outros sites.

Detalhes de uso e histórico de versões em [LEIA-ME.txt](LEIA-ME.txt).
