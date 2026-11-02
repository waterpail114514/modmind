import { $, hostItems, hostIcons } from './host.js';
const PAGE = 48;
export async function createPagedInventory({onSelect}) {
  let selected = null, current = [], count = 0, offset = 0, tab = 'block', timer, generation = 0, disposed = false;
  const names = new Map(), icons = new Map();
  let favorites;
  try { const stored=JSON.parse(localStorage.getItem('preview.favorites') || '[]');favorites=new Set(Array.isArray(stored)?stored.filter(id=>typeof id==='string').slice(-500):[]); }catch {favorites=new Set();}
  const recent = new Set();
  const grid = $('grid'), foot = $('invFoot');
  const tabs = [['block','方块'],['all','全部'],['recent','最近'],['fav','收藏']];
  $('tabs').replaceChildren(...tabs.map(([key,label]) => {
    const button = document.createElement('button'); button.className = 'btn'+(key === tab ? ' on' : ''); button.textContent = label;
    button.onclick = () => {tab = key;offset=0;$('tabs').querySelectorAll('button').forEach(b=>b.classList.toggle('on',b===button));void load();}; return button;
  }));
  function remember(id) {recent.delete(id);recent.add(id);if(recent.size>500)recent.delete(recent.keys().next().value);}
  async function select(id) {
    let row = current.find(row => row.id === id) || names.get(id);
    if(!row){try{row=(await hostItems({ids:[id],limit:1})).items[0];}catch{return false;}}
    if(!row || disposed) return false;
    selected = row;
    remember(id);
    $('selLine').textContent = row.name + ' · ' + row.id;
    grid.querySelectorAll('[data-id]').forEach(node => node.classList.toggle('sel',node.dataset.id===id));
    onSelect?.({...row,isBlock:row.block});
    return true;
  }
  async function load() {
    const request = ++generation;
    grid.setAttribute('aria-busy','true');
    try {
      const result = await hostItems({query:$('q').value,offset,limit:PAGE,namespace:$('ns').value,blocksOnly:tab==='block'||$('onlyBlock').checked,...(tab==='fav'?{ids:[...favorites]}:tab==='recent'?{ids:[...recent].slice(-500)}:{})});
      if(disposed || request !== generation) return;
      current = result.items; count=result.count;
      const namespaces=['',...(result.namespaces || [])];
      if(JSON.stringify([...$('ns').options].map(option=>option.value))!==JSON.stringify(namespaces)) {
        const previous=$('ns').value;
        $('ns').replaceChildren(...namespaces.map(value=>{const option=document.createElement('option');option.value=value;option.textContent=value || '全部来源';return option;}));
        if(namespaces.includes(previous))$('ns').value=previous;
      }
      $('invCount').textContent=count+' 项';
      $('sourceEmpty').hidden=true;
      grid.replaceChildren(...current.map(row => {
        if(names.size >= 1024) names.delete(names.keys().next().value);names.set(row.id,row);
        const cell=document.createElement('button');cell.className='cell'+(row.id===selected?.id?' sel':'');cell.dataset.id=row.id;cell.title=row.name+'\n'+row.id;cell.setAttribute('aria-label',row.name);
        const img=document.createElement('img');img.alt='';img.draggable=false;img.hidden=true;
        const label=document.createElement('span');label.className='fb';label.textContent=row.name;
        cell.append(img,label);cell.onclick=()=>select(row.id);
        return cell;
      }));
      if(!current.length) {const empty=document.createElement('p');empty.className='inventory-empty';empty.textContent='没有匹配的方块';grid.append(empty);}
      foot.replaceChildren();
      const prev=document.createElement('button');prev.className='btn';prev.textContent='上一页';prev.disabled=offset===0;prev.onclick=()=>{offset=Math.max(0,offset-PAGE);void load();};
      const next=document.createElement('button');next.className='btn';next.textContent='下一页';next.disabled=result.nextOffset===null;next.onclick=()=>{offset=result.nextOffset;void load();};
      const page=document.createElement('span');page.textContent=(Math.floor(offset/PAGE)+1)+' / '+Math.max(1,Math.ceil(count/PAGE));
      foot.append(prev,page,next);
      const missing=current.filter(row=>!icons.has(row.id)).map(row=>row.id);
      const urls=missing.length ? await hostIcons(missing).catch(()=>({})) : {};
      if(disposed || request !== generation) return;
      for(const [id,url] of Object.entries(urls || {})){if(icons.size>=512)icons.delete(icons.keys().next().value);icons.set(id,url);}
      for(const cell of grid.querySelectorAll('[data-id]')) {
        const url=icons.get(cell.dataset.id);if(!url)continue;
        const img=cell.querySelector('img');img.onload=()=>{img.hidden=false;cell.querySelector('.fb').hidden=true;};img.src=url;
      }
    } catch(error) {
      if(disposed || request!==generation)return;
      $('sourceEmpty').hidden=false;
      const message=String(error.message || error).replace(/^Error invoking remote method '[^']+': (?:Error: )?/,'');
      $('sourceMessage').textContent=message.includes('当前项目还没有采集数据') ? '还没有方块资源。选择本地游戏实例，即可预览和摆放方块。' : message;
      if(!$('ns').options.length){const option=document.createElement('option');option.value='';option.textContent='全部来源';$('ns').append(option);}
      $('invCount').textContent='';grid.replaceChildren();foot.replaceChildren();
    } finally { if(request===generation)grid.removeAttribute('aria-busy'); }
  }
  const search=()=>{clearTimeout(timer);timer=setTimeout(()=>{offset=0;void load();},180);};
  $('q').oninput=search;$('ns').onchange=()=>{offset=0;void load();};$('onlyBlock').onchange=()=>{offset=0;void load();};
  $('favorite').onclick=()=>{if(!selected)return;favorites.has(selected.id)?favorites.delete(selected.id):favorites.add(selected.id);try{localStorage.setItem('preview.favorites',JSON.stringify([...favorites].slice(-500)));}catch{};if(tab==='fav')void load();};
  await load();
  return {select,addRecent:remember,nameOf:id=>names.get(id)?.name||id,get selected(){return selected?.id||null;},get selectedRow(){return selected?{...selected,isBlock:selected.block}:null;},get total(){return count;},dispose:()=>{disposed=true;generation++;clearTimeout(timer);}};
}
