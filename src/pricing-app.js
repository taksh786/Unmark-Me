import { mountThemeSwitch } from './shared/themeSwitch.js';

const billingButtons = [...document.querySelectorAll('.billing [role="radio"]')];
const priceFields = [...document.querySelectorAll('[data-monthly][data-annual]')];
const compareDialog = document.getElementById('compareDialog');
const toast = document.getElementById('toast');
let toastTimer = 0;

function setBilling(period) {
    for (const button of billingButtons) {
        const selected = button.dataset.billing === period;
        button.setAttribute('aria-checked', String(selected));
        button.tabIndex = selected ? 0 : -1;
    }
    document.body.dataset.billing = period;
    for (const field of priceFields) {
        field.textContent = field.dataset[period];
    }
}

function setupBilling() {
    billingButtons.forEach((button, index) => {
        button.addEventListener('click', () => setBilling(button.dataset.billing));
        // Radio-group keyboard pattern: arrows move the selection.
        button.addEventListener('keydown', (event) => {
            if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
            event.preventDefault();
            const step = event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1;
            const next = billingButtons[(index + step + billingButtons.length) % billingButtons.length];
            setBilling(next.dataset.billing);
            next.focus();
        });
    });
}

function showToast(message) {
    toast.textContent = message;
    toast.hidden = false;
    // Next frame, so the entrance transition runs from the hidden state.
    requestAnimationFrame(() => toast.classList.add('is-visible'));
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
        toast.classList.remove('is-visible');
        toastTimer = setTimeout(() => { toast.hidden = true; }, 300);
    }, 3200);
}

function setupPlanButtons() {
    // Checkout isn't wired to a payment provider yet.
    for (const button of document.querySelectorAll('.plan-cta[data-plan]')) {
        button.addEventListener('click', () => {
            showToast(`${button.dataset.plan} is coming soon. You can use Unmark Me for free in the meantime.`);
        });
    }
}

function setupCompareDialog() {
    document.getElementById('compareOpen').addEventListener('click', () => compareDialog.showModal());
    document.getElementById('compareClose').addEventListener('click', () => compareDialog.close());
    // Clicking the dimmed backdrop closes the sheet.
    compareDialog.addEventListener('click', (event) => {
        if (event.target === compareDialog) compareDialog.close();
    });
}

// On phones the plans sit in a swipeable row; start it on the featured plan.
function centerFeaturedPlan() {
    const row = document.querySelector('.plans');
    const featured = row?.querySelector('.plan--featured');
    if (!row || !featured || row.scrollWidth <= row.clientWidth) return;
    row.scrollLeft = featured.offsetLeft - (row.clientWidth - featured.offsetWidth) / 2;
}

mountThemeSwitch(document.getElementById('themeSwitch'));
setBilling('monthly');
setupBilling();
setupPlanButtons();
setupCompareDialog();
centerFeaturedPlan();
