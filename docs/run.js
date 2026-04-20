const selector = document.getElementById('selector');
const content = document.getElementById('content');

function loadData(source) {
    console.log(`Loading data for: ${source}`);
    const url = `data/${source}/rows.json`;
    content.innerHTML = `<h2>${source}</h2>`;

    fetch(url)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const pre = document.createElement('pre');
            pre.textContent = JSON.stringify(data, null, 2);
            content.appendChild(pre);
        })
        .catch(error => {
            console.error('Error loading data:', error);
            content.innerHTML += `<p>Error loading data: ${error.message}</p>`;
        });
}

selector.addEventListener('change', (event) => {
    const source = event.target.value;
    loadData(source);
});

// Load data for the initial selection
loadData(selector.value);
