let speed = 10; // km/h
let distance = 0; // km
let upgradeCost = 100;
let upgradeIncrement = 5;
let points = 0;

const distanceElement = document.getElementById('distance');
const speedElement = document.getElementById('speed');
const upgradeCostElement = document.getElementById('upgrade-cost');
const trainElement = document.getElementById('train');
const upgradeButton = document.getElementById('upgrade-button');

function updateDisplay() {
    distanceElement.textContent = distance.toFixed(2);
    speedElement.textContent = speed;
    upgradeCostElement.textContent = upgradeCost.toFixed(0);
}

function moveTrain() {
    distance += speed / 3600; // Update distance per second
    trainElement.style.left = `${(distance * 10) % 800}px`; // Move train, loop back
    points += speed / 3600; // Gain points over time
    updateDisplay();
}

function upgradeTrain() {
    if (points >= upgradeCost) {
        points -= upgradeCost;
        speed += upgradeIncrement;
        upgradeCost *= 1.5; // Increase cost for next upgrade
        updateDisplay();
    } else {
        alert('Not enough points to upgrade!');
    }
}

upgradeButton.addEventListener('click', upgradeTrain);

// Start the game loop
setInterval(moveTrain, 1000 / 60); // 60 FPS

// Initial display update
updateDisplay();
