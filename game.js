class Player {
    constructor(balance) {
        this.balance = balance;
        this.inventory = [];
		this.boxIdCounter = 0;
        this.boxopedia = {
            'Box 1': false,
            'Box 2': false,
            'Box 3': false,
            'Box 4': false,
            'Box 5': false,
            'Box 6': false,
            'Box 7': false,
            'Box 8': false,
            'Box 9': false,
            'Box 10': false
        };
        this.updateBalance();
    }

    updateBalance() {
        document.getElementById('balance').textContent = `Balance: ${this.balance} coins`;
    }

    openBox() {
        if (this.balance < 100) {
            this.displayMessage("Du har inte tillräckligt med coins för att öppna lådan.");
            return;
        }

        this.balance -= 100;
        this.updateBalance();
        this.displayMessage("Du har öppnat en låda och 100 coins har dragits från din balans.");
this.hideAllBoxes(); 
 // Dölj Boxopedia innan öppningsanimationen börjar

        this.animateOpening(() => {
            let boxType = this.getRandomBox();
            this.inventory.push(boxType);
            this.displayMessage(`Grattis! Du fick ${boxType}.\nDin nya balans är ${this.balance} coins.`);
            this.showInventory();
        });
    }

    animateOpening(callback) {
        let animationElement = document.getElementById('animation');
        let boxes = Object.keys(this.getProbabilities());
        let index = 0;
        animationElement.style.display = 'flex';
        let interval = setInterval(() => {
            animationElement.textContent = boxes[index];
            index = (index + 1) % boxes.length;
        }, 100);

        setTimeout(() => {
            clearInterval(interval);
            animationElement.style.display = 'none';
            callback();
        }, 2000); // 2 seconds animation
    }

    getProbabilities() {
        return {
            'Box 1': 0.25,
            'Box 2': 0.20,
            'Box 3': 0.15,
            'Box 4': 0.10,
            'Box 5': 0.10,
            'Box 6': 0.08,
            'Box 7': 0.05,
            'Box 8': 0.03,
            'Box 9': 0.02,
            'Box 10': 0.02
        };
    }

    getRandomBox() {
        let probabilities = this.getProbabilities();
        let boxes = Object.keys(probabilities);
        let probs = Object.values(probabilities);
        let boxType = boxes[this.weightedRandomIndex(probs)];
        return boxType;
    }

    weightedRandomIndex(weights) {
        let sum = weights.reduce((acc, weight) => acc + weight, 0);
        let value = Math.random() * sum;
        for (let i = 0; i < weights.length; i++) {
            value -= weights[i];
            if (value <= 0) {
                return i;
            }
        }
        return weights.length - 1;
    }

openModal(boxType, boxDescription) {
        let modal = document.getElementById('modal');
        let boxName = document.getElementById('box-name');
        let boxDescriptionElement = document.getElementById('box-description');
        let boxId = document.getElementById('box-id');

        // Fyll modalen med information om den valda boxen
        boxName.textContent = boxType;
        boxDescriptionElement.textContent = boxDescription;
        boxId.textContent = `ID: ${this.generateBoxId()}`;

        // Visa modalen
        modal.style.display = 'block';

        // Lägg till eventlyssnare för att stänga modalen när användaren klickar på krysset
        let closeButton = document.getElementsByClassName('close')[0];
        closeButton.onclick = function() {
            modal.style.display = 'none';
        };
    }

    // Metod för att generera unika id för varje box
    generateBoxId() {
        return ++this.boxIdCounter;
    }


showInventory() {
    let output = document.getElementById('output');
    output.innerHTML = '';

    if (this.inventory.length === 0) {
        output.textContent = "Ditt inventory är tomt.";
    } else {
        this.inventory.forEach((boxType, index) => {
            let value = this.getBoxValue(boxType);
            let boxItem = document.createElement('div');
            boxItem.className = 'box-item';
            boxItem.innerHTML = `
                <img src="${boxType}.png" alt="${boxType}">
                ${boxType}: Värde ${value} coins
                <button onclick="player.sellBox(${index})">Sälj</button>
            `;
            output.appendChild(boxItem);
        });
    }
}

    sellBox(index) {
        let boxType = this.inventory[index];
        let boxValues = this.getBoxValues();

        if (index !== -1) {
            this.inventory.splice(index, 1);
            this.balance += boxValues[boxType];
            this.updateBalance();
            this.displayMessage(`Du har sålt ${boxType} för ${boxValues[boxType]} coins.\nDin nya balans är ${this.balance} coins.`);
            this.showInventory
			} else {
            this.displayMessage(`Du har ingen ${boxType} i ditt inventory.`);
        }
    }

    getBoxValues() {
        return {
            'Box 1': 50,
            'Box 2': 75,
            'Box 3': 100,
            'Box 4': 150,
            'Box 5': 200,
            'Box 6': 250,
            'Box 7': 300,
            'Box 8': 400,
            'Box 9': 500,
            'Box 10': 1000
        };
    }

    getBoxValue(boxType) {
        let boxValues = this.getBoxValues();
        return boxValues[boxType] || 0;
    }

    displayMessage(message) {
        document.getElementById('output').textContent = message;
    }

 


    hideAllBoxes() {
        let boxElements = document.querySelectorAll('.box');
        boxElements.forEach(box => {
            box.classList.add('hidden');
        });
    }

showBoxopedia() {
    let boxopediaDiv = document.getElementById('boxopedia');
    boxopediaDiv.innerHTML = '';

    Object.keys(this.boxopedia).forEach(boxType => {
        let boxDiv = document.createElement('div');
        boxDiv.classList.add('box');
        boxDiv.title = boxType;

        if (this.boxopedia[boxType]) {
            boxDiv.classList.add('acquired');
        }

        let overlayDiv = document.createElement('div');
        overlayDiv.classList.add('overlay'); // Lägg till överlagret för att simulera färgändringen

        let img = document.createElement('img');
        img.src = `${boxType}.png`;
        img.alt = boxType;

        boxDiv.appendChild(overlayDiv); // Lägg till överlagret till boxen
        boxDiv.appendChild(img);
        boxopediaDiv.appendChild(boxDiv);
    });

    boxopediaDiv.classList.toggle('hidden');
}

}


document.addEventListener('DOMContentLoaded', () => {
    window.player = new Player(500);

    document.getElementById('openBoxBtn').addEventListener('click', () => {
        player.openBox();
    });

    document.getElementById('showInvBtn').addEventListener('click', () => {
        player.showInventory();
    });

    document.getElementById('showBoxopediaBtn').addEventListener('click', () => {
        player.showBoxopedia();
    });

    document.getElementById('openBoxBtn').addEventListener('click', () => {
        player.hideBoxopedia(); // Lägg till denna rad för att dölja Boxopedia när du öppnar en låda
    });
});