let speed = 10; // km/h
let distance = 0; // km
let upgradeCost = 100;
let upgradeIncrement = 5;

const distanceElement = document.getElementById('distance');
const speedElement = document.getElementById('speed');
const trainElement = document.getElementById('train');
const upgradeButton = document.getElementById('upgrade-button');

function updateDisplay() {
    distanceElement.textContent = distance.toFixed(2);
    speedElement.textContent = speed;
}

function moveTrain() {
    distance += speed / 3600; // Update distance per second
    trainElement.style.left = `${distance * 10 % 800}px`; // Move train, loop back
    updateDisplay();
}

function upgradeTrain() {
    if (confirm(`Upgrade speed by ${upgradeIncrement} km/h for ${upgradeCost} points?`)) {
        speed += upgradeIncrement;
        upgradeCost *= 1.5; // Increase cost for next upgrade
    }
}

upgradeButton.addEventListener('click', upgradeTrain);

// Start the game loop
setInterval(moveTrain, 1000 / 60); // 60 FPS
