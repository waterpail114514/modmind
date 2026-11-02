export const TEMPLATE = `
<div id="app">
  <div id="bar" aria-label="建筑文件">
    <span class="grp" id="projGrp">
      <button class="btn grp-head document-head" id="projHead" aria-expanded="false" aria-haspopup="menu" title="选择建筑"><b id="projName">我的建筑</b><span class="caret">⌄</span></button>
      <div class="grp-pop wide" id="projPop" hidden role="menu">
        <div class="pop-title">当前项目的建筑</div><div class="proj-list" id="projList"></div><div class="pop-sep"></div>
        <button class="btn" id="newBtn" role="menuitem">新建建筑</button><button class="btn" id="projDup" role="menuitem">另存为副本</button><button class="btn" id="projRen" role="menuitem">重命名…</button>
        <button class="btn danger" id="projDel" role="menuitem">删除当前建筑</button><div class="pop-note" id="projUsage"></div>
        <button class="btn" id="legacyImport" role="menuitem" hidden>恢复旧版浏览器存档…</button>
      </div>
    </span>
    <span class="saveState" id="projSave" role="status">正在打开…</span>
    <span class="spacer"></span>
    <button class="btn" id="sourceBtn" title="选择本地游戏实例的方块资源">方块资源</button>
    <button class="btn" id="importBtn">导入建筑</button>
    <span class="grp" id="fileGrp"><button class="btn grp-head" id="fileHead" aria-expanded="false" aria-haspopup="menu">更多<span class="caret">⌄</span></button>
      <div class="grp-pop" id="filePop" hidden role="menu">
        <button class="btn" id="expSchem" role="menuitem">导出 Schem v2</button><button class="btn" id="expLitematic" role="menuitem">导出 Litematic</button>
        <button class="btn" id="matBtn" role="menuitem">材料清单</button><button class="btn" id="projBtn" role="menuitem">导入为投影…</button><button class="btn" id="originalBtn" role="menuitem">下载导入原件</button>
      </div>
    </span>
    <button class="btn primary" id="saveBtn" title="保存到当前项目（Ctrl+S）">保存建筑</button>
    <select id="sample" hidden><option value=""></option></select>
    <input type="file" id="importInput" accept=".nbt,.litematic,.schem" hidden><input type="file" id="projInput" accept=".nbt,.litematic,.schem" hidden>
  </div>
  <div id="editbar" aria-label="编辑与视图工具">
    <span class="tools" id="toolGroup">
      <button class="tool" id="m_pan" title="浏览 · 拖拽旋转视角（1）">浏览</button><button class="tool" id="m_place" title="摆放方块（2）">摆放</button><button class="tool" id="m_erase" title="删除方块（3）">删除</button><button class="tool" id="m_pick" title="拾取方块（4）">拾取</button><button class="tool" id="m_select" title="框选区域（5）">框选</button>
    </span><span class="sep"></span><button class="btn" id="undoBtn" title="撤销（Ctrl+Z）">撤销</button><button class="btn" id="redoBtn" title="重做（Ctrl+Y）">重做</button>
    <span class="spacer"></span><button class="btn" id="fitBtn" title="适应建筑（F）">适应</button>
    <span class="grp" id="mirrorGrp"><button class="btn grp-head" id="mirrorHead" aria-expanded="false" aria-haspopup="menu"><span class="dot" id="mirrorDot" hidden>·</span>视图<span class="caret">⌄</span></button>
      <div class="grp-pop" id="mirrorPop" hidden role="menu">
        <button class="btn" id="gridBtn" role="menuitem" title="显示或隐藏网格（G）">网格（开）</button><button class="btn" id="invBtn" role="menuitem" title="显示或隐藏方块栏（B）">方块栏</button>
        <button class="btn" id="originBtn" role="menuitem">整体移到原点</button><div class="pop-sep"></div>
        <button class="btn" id="mirrorBtn" role="menuitem" aria-pressed="false">镜像 X</button><button class="btn" id="mirrorBtnZ" role="menuitem" aria-pressed="false">镜像 Z</button>
        <label class="layer-control">分层 <input type="range" id="layer" min="0" max="15" value="15"><span id="layerVal">全部</span></label>
      </div>
    </span>
  </div>
  <div id="main">
    <div id="inv" aria-label="方块资源">
      <div id="invHead"><div class="row"><span class="inv-title">方块</span><span id="invCount" class="cnt"></span><span class="spacer"></span><button class="btn" id="favorite" title="收藏或取消收藏选中的方块" aria-label="收藏方块">☆</button></div>
        <input id="q" placeholder="搜索名称或 ID" aria-label="搜索方块" autocomplete="off" spellcheck="false">
        <div class="row"><select id="ns" aria-label="方块来源"></select><label class="only-block"><input type="checkbox" id="onlyBlock">仅方块</label></div><div id="tabs"></div>
      </div>
      <div id="sourceEmpty" hidden><p id="sourceMessage">选择一个本地游戏实例，载入它的方块资源。</p><button class="btn primary" id="setupSource">选择游戏实例</button><button class="btn" id="retrySource">重新加载</button></div>
      <div id="grid" aria-label="方块列表"></div><div id="selLine">选择一个方块开始摆放</div><div id="invFoot"></div>
    </div>
    <div id="stageWrap"><canvas id="stage" tabindex="0" aria-label="建筑三维视口"></canvas>
      <div id="overlay"><span class="tx" id="hintTx"></span><button class="x" id="hintClose" type="button" title="收起操作提示">×</button></div>
      <div id="selBar" hidden><span class="lb">选区 <b id="selCount">0</b> 格</span><button class="btn primary" id="selFill">填充</button><button class="btn" id="selClear">清空</button><button class="btn" id="selMove">移到原点</button><button class="btn" id="selCancel">取消</button></div>
      <div class="proj-bar" id="projBar" hidden><span class="pb-title">投影</span><button class="btn" id="projApply">按投影补全</button><button class="btn" id="projClear">清除投影</button><button class="btn" id="projHide">隐藏虚影</button></div>
      <div id="axisGizmo" aria-label="坐标轴方向"><span class="axl axl-x"><i>X</i></span><span class="axl axl-y"><i>Y</i></span><span class="axl axl-z"><i>Z</i></span></div>
      <div id="vcube" tabindex="0" title="点击切换视角，拖拽旋转，双击复位"><canvas id="vcubeCv" width="184" height="184"></canvas></div>
      <div id="resourceStatus" role="status" hidden></div><div id="err" role="alert"></div><div id="busy" role="status"></div>
      <div id="saveRecovery" role="alert" hidden><span id="saveError"></span><div><button class="btn" id="retrySave">重试保存</button><button class="btn primary" id="saveCopy">另存为新建筑</button><button class="btn" id="exportRecovery">导出 Schem</button></div></div>
    </div>
  </div>
  <div id="status"><span id="msg" role="status"></span><span class="spacer"></span><span class="grp">坐标 <b id="stCoord">—</b></span><span class="grp">尺寸 <b id="stSize">—</b></span><span class="grp secondary-stat">操作 <b id="stRev">0</b></span><span class="grp secondary-stat">历史 <b id="stHist">↶0 ↷0</b></span><span class="grp">方块 <b id="stBlocks">0</b></span></div>
</div>
<div id="dlg" role="dialog" aria-modal="true" aria-label="材料清单"><div id="dlgBox"><header><b>材料清单</b><span class="spacer"></span><button class="btn" id="dlgClose">关闭</button></header><div class="body" id="dlgBody"></div><footer><button class="btn primary" id="dlgCsv">下载 CSV</button></footer></div></div>
`;
