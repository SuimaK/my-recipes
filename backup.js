'use strict';
function backupPhoto(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
}
byId('export-backup').onclick = async () => {
  const button = byId('export-backup'); button.disabled = true;
  try {
    const snapshot = await new Promise((resolve, reject) => {
      const tx = database.transaction(['recipes','menus'], 'readonly');
      const recipes = tx.objectStore('recipes').getAll();
      const menus = tx.objectStore('menus').getAll();
      tx.oncomplete = () => resolve({recipes: recipes.result, menus: menus.result});
      tx.onabort = () => reject(tx.error);
    });
    for (const recipe of snapshot.recipes) recipe.photo = recipe.photo ? await backupPhoto(recipe.photo) : null;
    const data = {format:'recipekeeper-backup-v1', createdAt:new Date().toISOString(), ...snapshot};
    const url = URL.createObjectURL(new Blob([JSON.stringify(data)], {type:'application/json'}));
    const link = element('a'); link.href=url; link.download='recipes-backup-'+new Date().toISOString().slice(0,10)+'.json';
    document.body.append(link); link.click(); link.remove(); setTimeout(()=>URL.revokeObjectURL(url),60000);
    message('Копия подготовлена. Сохрани скачанный файл в «Файлы» или iCloud Drive.');
  } catch { message('Не удалось создать копию. Данные не изменены.'); }
  finally { button.disabled=false; }
};
let restoreData;
function validateBackup(data) {
  if(data?.format!=='recipekeeper-backup-v1'||!Array.isArray(data.recipes)||!Array.isArray(data.menus)) throw Error('Неверный формат копии');
  const ids=new Set();
  for(const r of data.recipes) {
    if(!Number.isInteger(r.id)||ids.has(r.id)||typeof r.title!=='string'||!r.title.trim()||typeof r.instructions!=='string'||!Number.isInteger(r.servings)||r.servings<1||r.servings>999||!Array.isArray(r.ingredients)||r.ingredients.some(i=>!i||['name','amount','unit'].some(k=>typeof i[k]!=='string'))) throw Error('Повреждён рецепт');
    ids.add(r.id);
    if(r.comments!=null&&(!Array.isArray(r.comments)||r.comments.some(c=>!c||typeof c.text!=='string'||typeof c.id!=='string'||!Number.isFinite(Date.parse(c.createdAt))))) throw Error('Повреждены заметки');
    if(r.photo!=null) {
      if(typeof r.photo!=='string'||!/^data:image\/(jpeg|png|webp|gif|heic|heif);base64,/i.test(r.photo)) throw Error('Неверный формат фото');
      const [header,body]=r.photo.split(','); const bytes=Uint8Array.from(atob(body),c=>c.charCodeAt(0));
      r.photo=new Blob([bytes],{type:header.slice(5,header.indexOf(';'))});
    }
  }
  for(const m of data.menus) if(typeof m.name!=='string'||!Array.isArray(m.entries)||m.entries.some(e=>!ids.has(e.recipeId)||!Number.isInteger(e.servings)||e.servings<1||e.servings>999)||m.purchased!=null&&(!Array.isArray(m.purchased)||m.purchased.some(x=>typeof x!=='string'))) throw Error('Повреждено меню или отсутствует связанный рецепт');
  return data;
}
byId('restore-file').onchange=async event=>{
  restoreData=null; byId('restore-backup').disabled=true;
  try {
    const file=event.target.files[0]; if(!file)return;
    if(file.size>250*1024*1024)throw Error('Копия больше 250 МБ');
    restoreData=validateBackup(JSON.parse(await file.text()));
    byId('restore-info').textContent=`Рецептов: ${restoreData.recipes.length}, меню: ${restoreData.menus.length}.`;
    byId('restore-backup').disabled=false;
  }catch(error){byId('restore-info').textContent='Копия не загружена: '+error.message;}
};
byId('restore-backup').onclick=async()=>{
  if(!restoreData)return;
  const button=byId('restore-backup'); button.disabled=true;
  try{
    await new Promise((resolve,reject)=>{
      const tx=database.transaction(['recipes','menus'],'readwrite'); const mapping=new Map();
      const recipes=tx.objectStore('recipes'); const menus=tx.objectStore('menus');
      let pending=restoreData.recipes.length;
      const addMenus=()=>{for(const source of restoreData.menus){const {id,...menu}=source; menus.add({...menu,entries:menu.entries.map(e=>({...e,recipeId:mapping.get(e.recipeId)}))});}};
      for(const source of restoreData.recipes){const {id,importKey,...recipe}=source; const request=recipes.add(recipe);request.onsuccess=()=>{mapping.set(id,request.result);if(--pending===0)addMenus();};}
      if(!pending)addMenus(); tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);
    });
    restoreData=null;byId('restore-file').value='';byId('restore-info').textContent='';
    await listRecipes();message('Рецепты и меню восстановлены.');
  }catch{message('Восстановление отменено из-за ошибки. Частичные данные не сохранены.');button.disabled=false;}
};
