const $=s=>document.querySelector(s), $$=s=>document.querySelectorAll(s);
const money=n=>Math.round(Number(n)||0).toLocaleString('ru-RU')+' ₽';
const ORDER_STORAGE_KEY='kpay-orders-v1';
let promo=false, payment='СБП';

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
  if(!orders.length){
    list.innerHTML='<div class="order-empty">Пока заказов нет. Создайте первый — и он появится здесь.</div>';
    return;
  }

  list.innerHTML=orders.slice().reverse().map(order=>`
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
  let a=Math.max(0,Number($('#amount').value)||0), fee=a*.07, cost=a*.02,total=a+fee+cost;
  if(promo)total*=.9;
  $('#credit').textContent=money(a);
  $('#fee').textContent=money(fee);
  $('#costs').textContent=money(cost);
  $('#total').textContent=money(total);
  $('#payAmount').textContent=money(total);
}

$$('[data-amount]').forEach(b=>b.addEventListener('click',()=>{$$('#steamForm .amount').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#amount').value=b.dataset.amount;calc()}));
$('#amount').addEventListener('input',()=>{$$('#steamForm .amount').forEach(x=>x.classList.toggle('selected',Number(x.dataset.amount)===Number($('#amount').value)));calc()});
$('#login').addEventListener('input',e=>{const input=e.currentTarget,start=input.selectionStart,cleaned=input.value.replace(/[^A-Za-z0-9_]/g,'');if(cleaned!==input.value){const cursor=input.value.slice(0,start).replace(/[^A-Za-z0-9_]/g,'').length;input.value=cleaned;input.setSelectionRange(cursor,cursor)}});
$$('.pay-option:not(:disabled)').forEach(b=>b.addEventListener('click',()=>{$$('.pay-option').forEach(x=>{x.classList.remove('selected');x.setAttribute('aria-pressed','false')});b.classList.add('selected');b.setAttribute('aria-pressed','true');payment=b.dataset.pay}));
$('#applyPromo').addEventListener('click',()=>{promo=$('#promo').value.trim().toUpperCase()==='KPAY10';$('#promoMsg').style.display='block';$('#promoMsg').textContent=promo?'Скидка 10% учтена в расчёте':'Промокод не найден';calc()});
$('#promo').addEventListener('input',()=>{if(promo){promo=false;calc()}});
$('#steamForm').addEventListener('submit',e=>{e.preventDefault();if(!$('#login').value.trim()){showToast('Введи логин Steam, чтобы увидеть расчёт.');$('#login').focus();return}if(!$('#agree').checked){showToast('Подтверди условия обработки данных, чтобы продолжить.');return}const amount=parseMoneyValue($('#payAmount').textContent);createOrder({title:'Пополнение Steam',meta:`Логин: ${$('#login').value.trim()} · ${payment} · ${promo ? 'Промокод применён' : 'Без промокода'}`,amount,status:'В обработке',statusClass:'pending'});});
$$('[data-stars]').forEach(b=>b.addEventListener('click',()=>{$$('#starAmounts .amount').forEach(x=>x.classList.remove('selected'));b.classList.add('selected');$('#starTotal').textContent=money(Number(b.dataset.stars)*2.5)}));
const prices={3:849,6:1599,12:2999},durationNames={3:'3 месяца',6:'6 месяцев',12:'12 месяцев'};
const periodToggle=$('#periodToggle'),periodOptions=$$('#periodOptions [data-period]');
function closePeriodMenu(returnFocus=false){periodOptions.forEach(option=>option.tabIndex=-1);$('#periodOptions').hidden=true;periodToggle.setAttribute('aria-expanded','false');if(returnFocus)periodToggle.focus()}
function openPeriodMenu(focusLast=false){$('#periodOptions').hidden=false;periodToggle.setAttribute('aria-expanded','true');const selected=$('#periodOptions [aria-selected="true"]'),options=[...periodOptions];options.forEach(option=>option.tabIndex=0);(focusLast?options[options.length-1]:selected).focus()}
function selectPeriod(value){const price=prices[value];if(!price)return;periodToggle.dataset.value=value;$('#periodValue').textContent=durationNames[value];$('#periodPrice').textContent=money(price);$('#premiumTotal').textContent=money(price);periodOptions.forEach(option=>{const selected=Number(option.dataset.period)===Number(value);option.classList.toggle('selected',selected);option.setAttribute('aria-selected',String(selected))})}
periodToggle.addEventListener('click',()=>periodToggle.getAttribute('aria-expanded')==='true'?closePeriodMenu():openPeriodMenu());
periodToggle.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();openPeriodMenu(event.key==='ArrowUp')}});
periodOptions.forEach(option=>option.addEventListener('click',()=>{selectPeriod(Number(option.dataset.period));closePeriodMenu(true)}));
$('#periodOptions').addEventListener('keydown',event=>{const options=[...periodOptions],index=options.indexOf(event.target);let next=index;if(event.key==='ArrowDown')next=(index+1)%options.length;else if(event.key==='ArrowUp')next=(index-1+options.length)%options.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=options.length-1;else if(event.key==='Escape'){event.preventDefault();closePeriodMenu(true);return}else if(event.key==='Tab'){closePeriodMenu();return}else return;event.preventDefault();options[next].focus()});
document.addEventListener('pointerdown',event=>{if(!event.target.closest('.duration-select')&&periodToggle.getAttribute('aria-expanded')==='true')closePeriodMenu()});
$$('.faq-q').forEach(b=>b.addEventListener('click',()=>{const item=b.closest('.faq-item'),open=item.classList.toggle('open');b.setAttribute('aria-expanded',String(open))}));
$('#menu').addEventListener('click',()=>{const n=$('#mobileNav'),open=n.classList.toggle('open');$('#menu').setAttribute('aria-expanded',String(open));$('#menu').textContent=open?'✕':'☰'});$$('#mobileNav a').forEach(a=>a.addEventListener('click',()=>{$('#mobileNav').classList.remove('open');$('#menu').setAttribute('aria-expanded','false');$('#menu').textContent='☰'}));
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
calc();

const orderButtons=$$('[data-order-type]');
orderButtons.forEach(button=>button.addEventListener('click',()=>{
  const type=button.dataset.orderType;
  if(type==='stars'){
    const amount=parseMoneyValue($('#starTotal').textContent);
    const recipient=$('#recipient').value.trim() || '@username';
    createOrder({title:'Telegram Stars',meta:`Получатель: ${recipient} · ${$('#starAmounts .amount.selected')?.dataset?.stars || '50'} ✦`,amount,status:'В обработке',statusClass:'pending'});
    return;
  }
  if(type==='premium'){
    const amount=parseMoneyValue($('#premiumTotal').textContent);
    const recipient=$('#premiumUser').value.trim() || '@username';
    const period=$('#periodValue').textContent.trim();
    createOrder({title:'Telegram Premium',meta:`Получатель: ${recipient} · ${period}`,amount,status:'В обработке',statusClass:'pending'});
  }
}));
}

renderOrders();
