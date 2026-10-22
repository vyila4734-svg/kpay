const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
const money=n=>Math.round(Number(n)||0).toLocaleString('ru-RU')+' ₽';
const ORDER_STORAGE_KEY='kpay-orders-v1';
let promo=false;

$$('img').forEach(image=>{image.draggable=false});
$$('a').forEach(link=>{
  if(link.querySelector('img'))link.draggable=false;
});
document.addEventListener('dragstart',event=>{
  if(event.target instanceof HTMLImageElement ||
    (event.target instanceof HTMLAnchorElement && event.target.querySelector('img'))){
    event.preventDefault();
  }
});

function parseMoneyValue(value){
  const digits=String(value ?? '').replace(/[^\d,.-]/g,'').replace(',', '.');
  return Number.parseFloat(digits) || 0;
}

function readOrders(){
  try {
    const raw=localStorage.getItem(ORDER_STORAGE_KEY);
    const parsed=raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    return [];
  }
}

function writeOrders(list){
  try {
    localStorage.setItem(ORDER_STORAGE_KEY, JSON.stringify(list));
  } catch (error) {
    console.warn('Не удалось сохранить заказы:', error);
  }
}

let orders=readOrders();
let apiOrders=[];
let apiOrdersError=false;
let toastTimer;

function showToast(msg){
  const toast=$('#toast');
  if(!toast)return;
  toast.textContent=msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer=setTimeout(()=>toast.classList.remove('show'),2800);
}

$$('[data-toast]').forEach(button=>button.addEventListener('click',event=>{
  if(button.tagName==='A')event.preventDefault();
  showToast(button.dataset.toast);
}));

function renderOrders(){
  const list=$('#ordersList');
  if(!list)return;
  const allOrders=orders.concat(apiOrders);
  if(!allOrders.length){
    list.innerHTML=apiOrdersError
      ? '<div class="order-empty">Не удалось загрузить заказы с сервера. Обнови страницу и попробуй снова.</div>'
      : '<div class="order-empty">Пока заказов нет. Создайте первый — и он появится здесь.</div>';
    return;
  }

  list.innerHTML=allOrders.slice().reverse().map(order=>`
    <article class="order-item">
      <div class="order-top">
        <span class="order-id">${escapeHTML(order.id)}</span>
          <span class="order-status ${escapeHTML(order.statusClass || '')}">${escapeHTML(order.status)}</span>
      </div>
        <h4>${escapeHTML(order.title)}</h4>
        <p>${escapeHTML(order.meta)}</p>
      <div class="order-meta">
          <span>${escapeHTML(order.date)}</span>
        <strong>${money(order.amount)}</strong>
      </div>
    </article>
  `).join('');
}

async function loadApiOrders(){
  if(!$('#ordersList'))return;
  try{
    const response=await fetch('/api/orders');
    const result=await response.json();
    if(!response.ok||!Array.isArray(result.orders)){
      throw new Error(result.error||'Не удалось загрузить историю заказов.');
    }
    apiOrders=result.orders;
    apiOrdersError=false;
  }catch(error){
    apiOrdersError=true;
    console.error('Не удалось загрузить заказы с сервера:',error);
  }
  renderOrders();
}

function escapeHTML(value){
  return String(value ?? '').replace(/[&<>"']/g,character=>({
    '&':'&amp;',
    '<':'&lt;',
    '>':'&gt;',
    '"':'&quot;',
    "'":'&#39;'
  })[character]);
}

function createOrder({title, meta, amount, status='В обработке', statusClass='pending'}){
  const order={
    id:`KPAY-${Date.now().toString().slice(-6)}`,
    title,
    meta,
    amount:Number(amount)||0,
    status,
    statusClass,
    date:new Date().toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'})
  };

  orders.push(order);
  writeOrders(orders);
  renderOrders();
  showToast(`Заказ ${order.id} создан.`);
  return order;
}

if($('#steamForm')){
function calc(){
  let a=Math.max(0,Number($('#amount').value)||0), total=a*1.1;
  if(promo)total*=.9;
  $('#credit').textContent=money(a);
  $('#total').textContent=money(total);
  $('#payAmount').textContent=money(a);
}

$$('[data-amount]').forEach(b=>b.addEventListener('click',()=>{$$('#steamForm .amount').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#amount').value=b.dataset.amount;calc()}));
$('#amount').addEventListener('input',()=>{$$('#steamForm .amount').forEach(x=>x.classList.toggle('selected',Number(x.dataset.amount)===Number($('#amount').value)));calc()});
$('#applyPromo').addEventListener('click',()=>{promo=$('#promo').value.trim().toUpperCase()==='KPAY10';$('#promoMsg').style.display='block';$('#promoMsg').textContent=promo?'Скидка 10% учтена в расчёте':'Промокод не найден';calc()});
$('#promo').addEventListener('input',()=>{if(promo){promo=false;calc()}});
$('#steamForm').addEventListener('submit',async e=>{
  e.preventDefault();
  const login=$('#login').value.trim();
  const amountRub=Number($('#amount').value);
  if(!login){showToast('Введи логин Steam для создания заказа.');$('#login').focus();return}
  if(!$('#agree').checked){showToast('Подтверди передачу логина Steam провайдеру для оформления заказа.');return}
  if(!/^[A-Za-z0-9_]{3,32}$/.test(login)){showToast('Укажи логин Steam: 3–32 латинских символа, цифры или подчёркивание. Email не поддерживается.');$('#login').focus();return}
  if(!Number.isInteger(amountRub)||amountRub<100||amountRub>100000){showToast('Укажи сумму от 100 до 100 000 ₽.');$('#amount').focus();return}

  const button=$('#steamForm .pay-button'),notice=$('#steamNotice');
  button.disabled=true;
  notice.textContent='Создаём заказ у поставщика…';
  try{
  const response=await fetch('/api/steam/orders',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({login,amountRub})
  });
  const result=await response.json();
  if(!response.ok){
    throw new Error(result.error||'Не удалось создать заказ.');
  }
  if(!result.order||typeof result.order.id!=='string'){
    throw new Error('Сервис вернул некорректные данные заказа. Проверь историю заказов.');
  }
  apiOrders.push(result.order);
  renderOrders();
  notice.textContent=`Заказ ${result.order.id} создан у поставщика. Логин Steam не проверялся; оплата не выполнялась.`;
  showToast(`Заказ ${result.order.id} создан. Оплата не выполнялась.`);
  }catch(error){
  notice.textContent=error.message||'Не удалось создать заказ. Попробуй позже.';
  showToast(error.message||'Не удалось создать заказ. Попробуй позже.');
  }finally{
    button.disabled=false;
  }
});
calc();
}
$$('[data-stars]').forEach(b=>{b.setAttribute('aria-pressed',String(b.classList.contains('selected')));b.addEventListener('click',()=>{$$('#starAmounts .amount').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false')});b.classList.add('selected');b.setAttribute('aria-pressed','true');const count=Number(b.dataset.stars);const total=money(count*2.5);$('#starTotal').textContent=total;if($('#starSummaryQuantity'))$('#starSummaryQuantity').textContent=`${count.toLocaleString('ru-RU')} ⭐`;if($('#starSummaryTotal'))$('#starSummaryTotal').textContent=total})});
if($('#recipient')&&$('#starSummaryRecipient'))$('#recipient').addEventListener('input',()=>{$('#starSummaryRecipient').textContent=$('#recipient').value.trim()||'@username'});
if($('#premiumUser')&&$('#premiumSummaryRecipient'))$('#premiumUser').addEventListener('input',()=>{$('#premiumSummaryRecipient').textContent=$('#premiumUser').value.trim()||'@username'});
const prices={3:849,6:1599,12:2999},durationNames={3:'3 месяца',6:'6 месяцев',12:'12 месяцев'};
const periodToggle=$('#periodToggle'),periodOptions=$$('#periodOptions [data-period]');
function closePeriodMenu(returnFocus=false){periodOptions.forEach(option=>option.tabIndex=-1);$('#periodOptions').hidden=true;periodToggle.setAttribute('aria-expanded','false');if(returnFocus)periodToggle.focus()}
function openPeriodMenu(focusLast=false){$('#periodOptions').hidden=false;periodToggle.setAttribute('aria-expanded','true');const selected=$('#periodOptions [aria-selected="true"]'),options=[...periodOptions];options.forEach(option=>option.tabIndex=0);(focusLast?options[options.length-1]:selected).focus()}
function selectPeriod(value){const price=prices[value];if(!price)return;if(periodToggle){periodToggle.dataset.value=value;$('#periodValue').textContent=durationNames[value];$('#periodPrice').textContent=money(price)}else if($('#periodValue'))$('#periodValue').textContent=durationNames[value];$('#premiumTotal').textContent=money(price);if($('#premiumSummaryPeriod'))$('#premiumSummaryPeriod').textContent=durationNames[value];if($('#premiumSummaryTotal'))$('#premiumSummaryTotal').textContent=money(price);periodOptions.forEach(option=>{const selected=Number(option.dataset.period)===Number(value);if(option.type==='radio'){option.checked=selected;option.closest('.duration-choice').classList.toggle('selected',selected)}else{option.classList.toggle('selected',selected);option.setAttribute('aria-selected',String(selected))}})}
if(periodToggle){
  periodToggle.addEventListener('click',()=>periodToggle.getAttribute('aria-expanded')==='true'?closePeriodMenu():openPeriodMenu());
  periodToggle.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openPeriodMenu(event.key==='ArrowUp')}});
  periodOptions.forEach(option=>option.addEventListener('click',()=>{selectPeriod(Number(option.dataset.period));closePeriodMenu(true)}));
  $('#periodOptions').addEventListener('keydown',event=>{const options=[...periodOptions],index=options.indexOf(event.target);let next=index;if(event.key==='ArrowDown')next=(index+1)%options.length;else if(event.key==='ArrowUp')next=(index-1+options.length)%options.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;else if(event.key==='Escape'){event.preventDefault();closePeriodMenu(true);return}else if(event.key==='Tab'){closePeriodMenu();return}else return;event.preventDefault();options[next].focus()});
  document.addEventListener('pointerdown',event=>{if(!event.target.closest('.duration-select')&&periodToggle.getAttribute('aria-expanded')==='true')closePeriodMenu()});
}else periodOptions.forEach(option=>option.addEventListener('change',()=>selectPeriod(Number(option.dataset.period))));
$$('.faq-q').forEach(b=>b.addEventListener('click',()=>{const item=b.closest('.faq-item'),open=item.classList.toggle('open');b.setAttribute('aria-expanded',String(open))}));
if($('#menu')){$('#menu').addEventListener('click',()=>{const n=$('#mobileNav'),open=n.classList.toggle('open');$('#menu').setAttribute('aria-expanded',String(open));$('#menu').textContent=open?'✕':'☰'});$$('#mobileNav a').forEach(a=>a.addEventListener('click',()=>{$('#mobileNav').classList.remove('open');$('#menu').setAttribute('aria-expanded','false');$('#menu').textContent='☰'}))}
const sections=$$('main section[id]');const navLinks=$$('.navlinks a');if('IntersectionObserver'in window){const obs=new IntersectionObserver(entries=>entries.forEach(e=>{if(e.isIntersecting)navLinks.forEach(a=>a.classList.toggle('active',a.getAttribute('href')==='#'+e.target.id))}),{rootMargin:'-25% 0px -65% 0px'});sections.forEach(s=>obs.observe(s))}
const revealSections=$$('main section:not(.hero)');
if('IntersectionObserver'in window){
  const revealObserver=new IntersectionObserver(entries=>entries.forEach(entry=>{
    if(entry.isIntersecting){
      entry.target.classList.add('is-visible');
      revealObserver.unobserve(entry.target);
    }
  }),{threshold:.12});
  revealSections.forEach(section=>{
    section.classList.add('home-reveal');
    revealObserver.observe(section);
  });
}else{
  revealSections.forEach(section=>section.classList.add('is-visible'));
}
const orderButtons=$$('[data-order-type]');
orderButtons.forEach(button=>button.addEventListener('click',()=>{
  const type=button.dataset.orderType;
  if(type==='stars'){
    const username=$('#recipient').value.trim().replace(/^@/,'');
    const notice=$('#starsNotice');
    if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)){
      const message='Укажи Telegram username: 5–32 латинских символа, цифры или подчёркивание.';
      if(notice)notice.textContent=message;
      showToast(message);
      $('#recipient').focus();
      return;
    }

    const originalLabel=button.innerHTML;
    button.disabled=true;
    button.textContent='Создаём заказ…';
    if(notice)notice.textContent='Создаём заказ у поставщика…';
    const packageId=Number($('#starAmounts .amount.selected')?.dataset?.serviceId);
    if(!Number.isInteger(packageId)){
      const message='Выбери пакет Telegram Stars.';
      if(notice)notice.textContent=message;
      showToast(message);
      button.disabled=false;
      button.innerHTML=originalLabel;
      return;
    }
    fetch('/api/stars/orders',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,packageId})
    }).then(async response=>{
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Не удалось создать заказ.');
      if(!result.order||typeof result.order.id!=='string'){
        throw new Error('Сервис вернул некорректные данные заказа. Проверь историю заказов.');
      }
      apiOrders.push(result.order);
      renderOrders();
      const message=`Заказ ${result.order.id} создан у поставщика. Оплата не выполнялась.`;
      if(notice)notice.textContent=message;
      showToast(message);
    }).catch(error=>{
      const message=error.message||'Не удалось создать заказ. Попробуй позже.';
      if(notice)notice.textContent=message;
      showToast(message);
    }).finally(()=>{
      button.disabled=false;
      button.innerHTML=originalLabel;
    });
    return;
  }
  if(type==='premium'){
    const username=$('#premiumUser').value.trim().replace(/^@/,'');
    const selectedPeriod=$$('#periodOptions [data-period]').find(option=>option.checked||option.classList.contains('selected'));
    const packageId=Number(selectedPeriod?.dataset?.serviceId);
    const notice=$('#premiumNotice');
    if(!/^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username)){
      const message='Укажи Telegram username: 5–32 латинских символа, цифры или подчёркивание.';
      if(notice)notice.textContent=message;
      showToast(message);
      $('#premiumUser').focus();
      return;
    }
    if(!Number.isInteger(packageId)){
      const message='Выбери срок Telegram Premium.';
      if(notice)notice.textContent=message;
      showToast(message);
      return;
    }

    const originalLabel=button.innerHTML;
    button.disabled=true;
    button.textContent='Создаём заказ…';
    if(notice)notice.textContent='Создаём заказ у поставщика…';
    fetch('/api/premium/orders',{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({username,packageId})
    }).then(async response=>{
      const result=await response.json();
      if(!response.ok)throw new Error(result.error||'Не удалось создать заказ.');
      if(!result.order||typeof result.order.id!=='string'){
        throw new Error('Сервис вернул некорректные данные заказа. Проверь историю заказов.');
      }
      apiOrders.push(result.order);
      renderOrders();
      const message=`Заказ ${result.order.id} создан у поставщика. Оплата не выполнялась.`;
      if(notice)notice.textContent=message;
      showToast(message);
    }).catch(error=>{
      const message=error.message||'Не удалось создать заказ. Попробуй позже.';
      if(notice)notice.textContent=message;
      showToast(message);
    }).finally(()=>{
      button.disabled=false;
      button.innerHTML=originalLabel;
    });
  }
}));
renderOrders();
loadApiOrders();
