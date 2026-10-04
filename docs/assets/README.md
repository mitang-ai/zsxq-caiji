# README 配图

两张图使用内置绘图工具，遵循「极简线条信息图」skill；原始生成尺寸均为 **1672 × 941**，近似 16:9，未裁剪。白底、黑线、少量蓝色流程箭头，不含个人数据。

- `knowledge-flow.png`：原文 → 整理 → 批准 → 成果。
- `two-workspaces.png`：本地插件与 Web 工作台的可选加工、显式同步关系。

这是概念示意，不是界面截图或功能验收证据；模型加工和同步均可跳过。不标注未获工具回执确认的模型版本。

## 生成提示词

### knowledge-flow

```text
Use case: infographic-diagram. Asset type: tasteful GitHub README hero infographic for the open-source knowledge workbench 星笺. Generate a new horizontal 16:9 image, preferably exactly 2048×1152, pure white background, generous white space and 10% safe margins. Draw a single left-to-right four-stage knowledge workflow in the middle band. Stage one: a neat stack of source documents and a small discussion-bubble icon; label 原文. Stage two: an open document being highlighted, with tiny simple bookmark/tag shapes, no decorative writing; label 整理. Stage three: one minimalist circular-head line person reading the selected document and approving it with a clear checkmark, representing the human approval gate before AI processing; label 批准. Stage four: a finished document with a small source-reference link icon attached and a pen, representing an editable cited draft; label 成果. Connect the four stages with exactly three restrained bright-blue (#2563EB) rightward arrows. Keep all drawings black with clean thick naturally hand-drawn contours, white interiors, equal visual weight, and labels large and legible. No heading is needed, the surrounding README contains the product title. Allowed visible text EXACTLY and ONLY: 原文, 整理, 批准, 成果. Do not add any other text, slogans, numbers, notes, English, logos, watermark, decoration, sparkle, gradients, shading, paper texture, realistic rendering, UI screenshots, or claims of performance. Not a dense poster: the relationships and human approval must be immediately clear.
```

### two-workspaces

```text
Use case: infographic-diagram. Asset type: second GitHub README explanatory illustration for the open-source 星笺 workbench. New horizontal 16:9 image, preferably exactly 2048×1152, pure white, black clean thick naturally hand-drawn line art, generous white space, large readable Simplified Chinese labels, 10% safe margins. Explain TWO distinct workspaces with a clear horizontal divide made only by whitespace. Top lane is titled 本地插件, contains a browser-window outline at upper left with label 本地采集; to its right a small model-processing box labeled 自配模型, then a download/file outline labeled 本地导出. Exactly two short thin bright-blue right arrows connect this upper example workflow. Bottom lane is titled Web 工作台: two small source boxes on the lower left, labeled 官方 MCP and 网页连接, converge with two short right arrows into a document shelf labeled 资料库 at lower center; then one arrow to a clear human approval checkmark inside a document panel labeled 批准加工; then one arrow to a document with attached source-link symbol labeled 引用成果. Add ONE dashed vertical downward blue arrow from the upper local collection/document area into the lower 资料库; the arrow is labeled 显式同步 to make it clear this is OPTIONAL USER-CONFIRMED TRANSFER, not automatic upload. Route the dashed arrow in the whitespace between lanes without crossing or colliding with other arrows or labels. This is a conceptual workflow, NOT a UI screenshot. Only two source boxes converge, do not add servers, external clouds, or connectors. Allowed visible text EXACTLY and ONLY: 本地插件, 本地采集, 自配模型, 本地导出, 显式同步, Web 工作台, 官方 MCP, 网页连接, 资料库, 批准加工, 引用成果. No other writing, captions, footer, decorative numbers, slogans, logo, watermark, gradients, shadows, texture, sparkles, or unrelated objects. Use only black and white plus blue for actual directional arrows. Keep the optional sync relationship and human approval unambiguous.
```
