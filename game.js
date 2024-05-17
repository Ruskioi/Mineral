class Player {
    constructor(balance) {
        this.balance = balance;
        this.inventory = [];
    }

    openBox() {
        if (this.balance < 100) {
            this.displayMessage("Du har inte tillräckligt med coins för att öppna lådan.");
            return;
        }

        this.balance -= 100;
        this.displayMessage("Du har öppnat en låda och 100 coins har dragits från din balans.");
        
        let boxType = this.getRandomBox();
        this.inventory.push(boxType);
        this.displayMessage(`Grattis! Du fick ${boxType}.\nDin nya balans är ${this.balance} coins.`);
    }

    getRandomBox() {
        let probabilities = {
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

    showInventory() {
        if (this.inventory.length === 0) {
            this.displayMessage("Ditt inventory är tomt.");
        } else {
            let inventoryMessage = "Ditt inventory:\n";
            this.inventory.forEach(box => {
                let value = this.getBoxValue(box);
                inventoryMessage += `- ${box}: Värde ${value} coins\n`;
            });
            this.displayMessage(inventoryMessage);
        }
    }

    sellBox(boxType) {
        let boxValues = {
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

        let index = this.inventory.indexOf(boxType);
        if (index !== -1) {
            this.inventory.splice(index, 1);
            this.balance += boxValues[boxType];
            this.displayMessage(`Du har sålt ${boxType} för ${boxValues[boxType]} coins.\nDin nya balans är ${this.balance} coins.`);
        } else {
            this.displayMessage(`Du har ingen ${boxType} i ditt inventory.`);
        }
    }

    boxValue(boxType) {
        let boxValues = {
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

        if (this.inventory.includes(boxType)) {
            let value = boxValues[boxType];
            this.displayMessage(`${boxType} är värd ${value} coins.`);
        } else {
            this.displayMessage(`Du har ingen ${boxType} i ditt inventory.`);
        }
    }

    getBoxValue(boxType) {
        let boxValues = {
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

        return boxValues[boxType] || 0;
    }

    displayMessage(message) {
        document.getElementById('output').textContent = message;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    let player = new Player(500);

    document.getElementById('openBoxBtn').addEventListener('click', () => {
        player.openBox();
    });

    document.getElementById('showInvBtn').addEventListener('click', () => {
        player.showInventory();
    });

    document.getElementById('sellBoxBtn').addEventListener('click', () => {
        let boxType = document.getElementById('boxInput').value;
        player.sellBox(boxType);
    });

    document.getElementById('valueBoxBtn').addEventListener('click', () => {
        let boxType = document.getElementById('boxInput').value;
        player.boxValue(boxType);
    });
});
