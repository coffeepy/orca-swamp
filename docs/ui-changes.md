# UI changes

Changes to make to the plugin's UI. Nothing here is built yet.

1. **Show this repo's workflows first, then group the others by extension. Do not hide any.**
   Workflows with a scoped name, such as `@swamp/stagecraft/claim`, come from an installed extension.
   Workflows with a plain name, such as `verify-v3`, are files in the repo's `workflows/` folder.
   Put the repo's own workflows at the top. Below them, show one group per extension, for example "StageCraft".
   Keep the runs of extension workflows visible.
   Why: the StageCraft extension adds six workflows, and they look like workflows you built.
   They still run (claim, create and publish ran in the shop repo), so their history matters.

2. **Show which workflow a factory stage runs.**
   A stage can run a workflow. For example, the verify stage in `shop-v3-factory` runs `verify-v3`.
   Show this on the stage, and on the workflow show which factories use it.
   Why: the Workflows tab does not show which workflows a factory uses.

3. **Pick the repo per workspace, not across workspaces.**
   When you switch to another Orca workspace, the panel shows that workspace's own repo.
   If you pick a different repo in a workspace, the panel keeps that pick for that workspace only.
   Why: today a pick can stay in place when you switch workspaces, so the panel can show the wrong repo.

4. **Show a workflow's recent runs under its latest run.**
   When you click a workflow, the panel shows its latest run, as it does now.
   Below that run, list the workflow's recent runs. Click one to open it, and use Back to return.
   Why: today you can only reach older runs from the shared "Recent runs" list on the Workflows tab.

5. **Make the StageCraft tab work like the Workflows tab.**
   - Rename the "Factories" tab to "StageCraft".
   - Remove the factory dropdown and its "write → check → ship" label.
   - The tab opens on a searchable list of the repo's factories, with one card per factory, like the workflow cards.
   - A factory card has a bar of its latest tickets, like a workflow card's bar of its latest runs:
     green is done, grey is abandoned, and blue, yellow or orange is in progress.
     The card also says how many tickets need you, for example "2 need you".
   - Click a card to open the factory view from mockups H and I: filter chips, the grid of tickets by stage, and recent runs.
   - Click a ticket in that view to open the single ticket view that exists now. Back returns each step.
   - Keep the Studio link, and do not change how it works. It goes in the factory view header, next to the factory name,
     and it starts and opens the studio the same way it does now.
   Mockups: boards H and I of the design canvas.
