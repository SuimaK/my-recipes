'use strict';
function pdfLines(items,height,page) {
 const rows=[];
 for(const t of items){if(!t.str?.trim())continue;const x=t.transform[4],y=height-t.transform[5],size=Math.abs(t.transform[3])||12,last=rows.at(-1);
 if(last&&Math.abs(last.y-y)<3&&x>=last.x&&x-last.right<18){last.text+=' '+t.str.trim();last.right=x+t.width;last.size=Math.max(last.size,size);}else rows.push({text:t.str.trim(),x,y,right:x+t.width,size,page});}
 return rows.filter(l=>!(l.y>height*.93&&/^\d+$/.test(l.text))).sort((a,b)=>a.y-b.y||a.x-b.x);
}
function pdfRecipeDrafts(pages){
 const lines=pages.flatMap(p=>p.lines.map(l=>({...l,pos:p.number*100000+l.y}))),anchors=[];
 const ingredients=/^(?:ингредиенты|продукты|состав)(?:\s|:|$)/iu,method=/^(?:(?:способ|этапы)\s+)?приготовлени[ея](?:\s*[:：]|$)/iu;
 for(let i=0;i<lines.length;i++){
  const l=lines[i];if(!ingredients.test(l.text))continue;
  const recent=lines.slice(Math.max(0,i-25),i).filter(t=>t.page===l.page&&!/^\d+$/.test(t.text)&&!/(?:порци|литр|ингредиент|приготовлени)/iu.test(t.text));
  const sizes=pages.find(p=>p.number===l.page).lines.map(t=>t.size).sort((a,b)=>a-b),body=sizes[Math.floor(sizes.length/2)]||12;
  const big=recent.filter(t=>t.size>body*1.12&&t.text.length<160);let titleLine=big.at(-1)||recent.at(-1),title=titleLine?.text||'Рецепт со страницы '+l.page;
  if(titleLine){const before=recent[recent.indexOf(titleLine)-1];if(before&&Math.abs(before.size-titleLine.size)<1&&titleLine.y-before.y<titleLine.size*1.8&&titleLine.size>body*1.12){title=before.text+' '+title;titleLine=before;}}
  anchors.push({index:i,title:title.replace(/\s+\d+(?:[–-]\d+)?\s+порци.*$/iu,'').slice(0,160),start:titleLine?.pos??l.pos,page:l.page});
 }
 const drafts=[];
 for(let a=0;a<anchors.length;a++){
  const h=anchors[a],next=anchors[a+1],heading=lines[h.index],range=lines.slice(h.index+1).filter(l=>!next||l.pos<next.start);
  const m=range.findIndex(l=>method.test(l.text));if(m<0)continue;
  let start=m+1;const raw=range.slice(0,m);
  while(start<range.length&&range[start].page===range[m].page&&range[start].y-range[m].y<heading.size*1.2&&range[start].x>range[m].x+80)raw.push(range[start++]);
  const cols=[];
  for(const l of [...raw].sort((a,b)=>a.x-b.x)){
   if(/^(?:для\s|тесто\s*:|начинка\s*:|льезон\s*:)/iu.test(l.text)&&!/[—–]\s*\d/u.test(l.text))continue;
   let col=cols.find(c=>Math.abs(c[0].x-l.x)<45);if(!col){col=[];cols.push(col);}col.push(l);
  }
  const foods=[];
  for(const col of cols){col.sort((a,b)=>a.pos-b.pos);for(let i=0;i<col.length;i++){
   let t=col[i].text;
   if(!/[—–:]|\d/u.test(t)&&col[i+1]&&/[—–]\s*(?:\d|[½¼⅓⅔¾])/u.test(col[i+1].text)&&col[i+1].y-col[i].y<col[i].size*1.7&&!/по вкусу|для (?:жарки|замачивания)/iu.test(t))t+=' '+col[++i].text;
   else if(t.endsWith('—')&&col[i+1])t+=' '+col[++i].text;
   foods.push(t.replace(/(\d)\s*гр\b/gu,'$1 г'));
  }}
  const steps=[];for(const l of range.slice(start)){if(l.page>h.page+3||l.size>heading.size*1.25&&!method.test(l.text))break;steps.push(l.text);}
  if(!foods.length||!steps.length)continue;
  const nearby=lines.filter(l=>l.page===h.page&&l.pos>=h.start&&l.pos<=heading.pos).map(l=>l.text).join(' ');
  const portions=/(\d+)(?:[–-](\d+))?\s*порци/iu.exec(nearby),count=portions?+portions[1]:1;
  const note=portions?(portions[2]?`В книге указано ${portions[1]}–${portions[2]} порций; для пересчёта принято ${count}.`:''):'Порции не найдены: 1 порция означает всю закладку. Уточните перед сохранением.';
  drafts.push({page:h.page,text:[h.title,'Порции: '+count,'Ингредиенты:',...foods,'Приготовление:',steps.join(' '),note].filter(Boolean).join('\n')});
 }
 return drafts;
}
let pdfCancelled=false,pdfDraftRows=[],pdfBusy=false;
byId('pdf-cancel').onclick=()=>{pdfCancelled=true;byId('pdf-cancel').textContent='Останавливаю после текущей страницы…';};
function resetPDFReview(){pdfDraftRows=[];byId('pdf-review').hidden=true;byId('pdf-drafts').replaceChildren();}
function renderPDFReview(drafts,raw,name){
 byId('pdf-review').hidden=false;byId('pdf-drafts').replaceChildren();pdfDraftRows=[];byId('pdf-raw').value=raw;byId('pdf-file-name').textContent=name;
 byId('pdf-result').textContent=drafts.length?`Найдено рецептов: ${drafts.length}. Проверь состав и приготовление каждой карточки.`:'Рецепты не удалось уверенно разделить. Исправь извлечённый текст ниже и повтори разбор либо создай одну карточку.';
 for(const draft of drafts){const box=element('details'),summary=element('summary',`Стр. ${draft.page} · ${draft.text.split('\n')[0]}`),label=element('label','Загрузить этот рецепт'),check=element('input');check.type='checkbox';check.checked=true;label.prepend(check);
 const editLabel=element('label','Текст карточки'),editor=element('textarea');editor.rows=12;editor.value=draft.text;editLabel.append(editor);box.append(summary,label,element('p','Проверь название, количества и шаги. Сохраняй заголовки «Ингредиенты» и «Приготовление».'),editLabel);byId('pdf-drafts').append(box);pdfDraftRows.push({check,editor,page:draft.page});}
 byId('pdf-save').disabled=byId('pdf-download').disabled=!drafts.length;
}
async function convertPDF(file){
 resetPDFReview();pdfCancelled=false;pdfBusy=true;byId('pdf-cancel').hidden=false;byId('pdf-cancel').textContent='Отменить обработку';
 let task,worker;try{
  const lib=await import('./vendor/pdf/pdf.min.mjs'),path=new URL('./vendor/pdf/',location.href).href;lib.GlobalWorkerOptions.workerSrc=path+'pdf.worker.min.mjs';
  task=lib.getDocument({data:await file.arrayBuffer(),cMapUrl:path+'cmaps/',cMapPacked:true,standardFontDataUrl:path+'standard_fonts/',wasmUrl:path+'wasm/',isEvalSupported:false});const pdf=await task.promise;
  const first=Number(byId('pdf-first').value)||1,last=Number(byId('pdf-last').value)||pdf.numPages;
  if(!Number.isInteger(first)||!Number.isInteger(last)||first<1||last<first||last>pdf.numPages)throw Error(`В PDF ${pdf.numPages} страниц. Проверь диапазон.`);
  if(last-first>=300)throw Error('Выбери не более 300 страниц за один раз.');
  const pages=[];
  for(let number=first;number<=last;number++){
   if(pdfCancelled)throw Error('Обработка отменена. Рецепты не сохранены.');message(`PDF: страница ${number} из ${last}. Обработка на устройстве…`);
   const page=await pdf.getPage(number),vp=page.getViewport({scale:1}),content=await page.getTextContent();let lines=pdfLines(content.items,vp.height,number);
   if(lines.map(l=>l.text).join('').length<35){message(`Распознаю скан: страница ${number} из ${last}…`);worker??=await createOCR();const viewport=page.getViewport({scale:Math.min(3,2200/Math.max(vp.width,vp.height))}),canvas=element('canvas');canvas.width=Math.ceil(viewport.width);canvas.height=Math.ceil(viewport.height);
    try{await page.render({canvasContext:canvas.getContext('2d'),viewport}).promise;const data=(await worker.recognize(canvas)).data;lines=data.text.split('\n').map((text,i)=>({text:text.trim(),x:0,y:i*16,size:12,page:number})).filter(l=>l.text);}finally{canvas.width=canvas.height=0;}}
   pages.push({number,lines});page.cleanup();await new Promise(resolve=>setTimeout(resolve,0));
  }
  if(pdfCancelled)throw Error('Обработка отменена. Рецепты не сохранены.');
  const raw=pages.map(p=>`Страница ${p.number}\n`+p.lines.map(l=>l.text).join('\n')).join('\n\n');renderPDFReview(pdfRecipeDrafts(pages),raw,file.name);message('PDF преобразован в черновики. Проверь их и выбери, что сохранить.');
 }finally{if(task)await task.destroy();if(worker)await worker.terminate();pdfBusy=false;byId('pdf-cancel').hidden=true;}
}
async function selectedPDFCollection(){
 const recipes=[];
 for(const row of pdfDraftRows){if(!row.check.checked)continue;const recipe=parseRecipe(row.editor.value);
  if(!recipe.title||!recipe.ingredients.length||!recipe.instructions)throw Error('Заполни название, ингредиенты и приготовление во всех выбранных карточках.');
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(recipe))),key=Array.from(new Uint8Array(digest),n=>n.toString(16).padStart(2,'0')).join('');
  recipes.push({...recipe,importKey:'pdf-'+key,category:inferCategory(recipe),photo:null});
 }
 if(!recipes.length)throw Error('Выбери хотя бы один рецепт.');
 const collection={format:'recipekeeper-collection-v1',recipes};readCollection(collection);return collection;
}
byId('pdf-download').onclick=async()=>{try{const data=await selectedPDFCollection(),url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})),link=element('a');link.href=url;link.download='recipes-from-pdf.json';document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(e){message(e.message);}};
byId('pdf-save').onclick=async()=>{const save=byId('pdf-save');save.disabled=true;try{const data=await selectedPDFCollection();await importCollection(new File([JSON.stringify(data)],'recipes.json',{type:'application/json'}));resetPDFReview();}catch(e){message(e.message);}finally{save.disabled=false;}};
byId('pdf-reparse').onclick=()=>{const text=byId('pdf-raw').value,lines=text.split('\n').map((text,i)=>({text:text.trim(),x:0,y:i*16,size:12,page:1})).filter(l=>l.text);renderPDFReview(pdfRecipeDrafts([{number:1,lines}]),text,byId('pdf-file-name').textContent);};
byId('pdf-single').onclick=()=>{const text=byId('pdf-raw').value;renderPDFReview([{page:1,text}],text,byId('pdf-file-name').textContent);};
